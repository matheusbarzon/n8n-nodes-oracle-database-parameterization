import { IExecuteFunctions } from "n8n-core";

import {
  IDataObject,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  NodeOperationError,
} from "n8n-workflow";
import oracledb from "oracledb";
import { OracleConnection } from "./core/connection";

export class OracleDatabase implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Oracle Database with Parameterization ",
    name: "Oracle Database with Parameterization",
    icon: "file:oracle.svg",
    group: ["input"],
    version: 1,
    description: "Upsert, get, add and update data in Oracle database",
    defaults: {
      name: "Oracle Database",
    },
    inputs: ["main"],
    outputs: ["main"],
    credentials: [
      {
        name: "oracleCredentials",
        required: true,
      },
    ],
    properties: [
      {
        displayName: "SQL Statement",
        name: "query",
        type: "string",
        typeOptions: {
          alwaysOpenEditWindow: true,
        },
        default: "",
        placeholder: "SELECT id, name FROM product WHERE id < :param_name",
        required: true,
        description: "The SQL query to execute",
      },
      {
        displayName: 'Parameters',
        name: 'params',
        placeholder: 'Add Parameter',
        type: 'fixedCollection',
        typeOptions: {
          multipleValueButtonText: 'Add another Parameter',
          multipleValues: true,
        },
        default: {},
        options: [
          {
            displayName: 'Values',
            name: 'values',
            values: [
              {
                displayName: 'Name',
                name: 'name',
                type: 'string',
                default: '',
                placeholder: 'e.g. param_name',
                hint: 'Do not start with ":"',
                required: true,
              },
              {
                displayName: 'Value',
                name: 'value',
                type: 'string',
                default: '',
                placeholder: 'Example: 12345',
                required: true,
                displayOptions: {
                  show: {
                    'direction': ['in', 'inout']
                  }
                },
              },
              {
                displayName: 'Data Type',
                name: 'datatype',
                type: 'options',
                required: true,
                default: 'string',
                options: [
                  { name: 'String', value: 'string' },
                  { name: 'Number', value: 'number' }
                ]
              },
              {
                displayName: 'Parse for IN statement',
                name: 'parseInStatement',
                type: 'options',
                required: true,
                default: false,
                hint: 'If "Yes" the "Value" field should be a string of comma-separated values. i.e: 1,2,3 or str1,str2,str3',
                options: [
                  { name: 'No', value: false },
                  { name: 'Yes', value: true }
                ]
              },
              {
                displayName: 'Parameter Direction',
                name: 'direction',
                type: 'options',
                required: true,
                default: 'in',
                hint: 'Specifies if the parameter is for input (IN), output (OUT), or both (IN/OUT).',
                options: [
                  { name: 'In', value: 'in' },
                  { name: 'Out', value: 'out' },
                  { name: 'In/Out', value: 'inout' }
                ],
              }
            ],
          },
        ],
      },
    ],
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    if (typeof String.prototype.replaceAll === "undefined") {
      String.prototype.replaceAll = function (match, replace) {
        return this.replace(new RegExp(match, 'g'), () => replace);
      }
    }

    const credentials = await this.getCredentials("oracleCredentials");
    const oracleCredentials = {
      user: String(credentials.user),
      password: String(credentials.password),
      connectionString: String(credentials.connectionString),
    };

    const db = new OracleConnection(
      oracleCredentials,
      Boolean(credentials.thinMode)
    );
    const connection = await db.getConnection();

    let returnItems = [];

    try {
      //get query
      let query = this.getNodeParameter("query", 0) as string;

      const executeManyOptions: oracledb.ExecuteManyOptions = {
        autoCommit: true,
        bindDefs: { },
      };

      const bindParameters: oracledb.BindParameters[] = [];

      //get list of param objects entered by user:
      const parameterIDataObjectList = (
        (this.getNodeParameter('params', 0, {}) as IDataObject).values as {
          name: string,
          value: string | number,
          datatype: string,
          parseInStatement: boolean,
          direction: string,
        }[]
      ) || [];

      for (const item of parameterIDataObjectList) {
        //set data type to be correct type
        let datatype: number | string | undefined = undefined;
        if (item.datatype && item.datatype === 'number') {
          datatype = oracledb.NUMBER;
        } else {
          datatype = oracledb.STRING;
        }

        const direction: Record<string, number> = {
          "in": oracledb.BIND_IN,
          "inout": oracledb.BIND_INOUT,
          "out": oracledb.BIND_OUT,
        }

        executeManyOptions.bindDefs = {
          ...executeManyOptions.bindDefs,
          [item.name]: {
            type: datatype,
            dir: direction[item.direction],
          }
        };

        if (!item.parseInStatement) {
          //normal process.
          bindParameters.push({
            [item.name]: {
              type: datatype,
              val: item.datatype === 'number'
                ? Number(item.value)
                : String(item.value)
            }
          });
          continue;
        }

        //we make it possible to use a parameter for an IN statement
        const valList = item.value.toString().split(',');
        let generatedSqlString = '(';
        const crypto = require('crypto');
        for (let i = 0; i < valList.length; i++) {
          //generate unique parameter names for each item in list
          const uniqueId: String = crypto.randomUUID().replaceAll('-', '_'); //dashes don't work in parameter names.
          const newParamName = item.name + uniqueId;

          //add new param to param list
          bindParameters.push({
            [newParamName]: {
              type: datatype,
              val: item.datatype && item.datatype === 'number'
                ? Number(valList[i])
                : String(valList[i])
              }
          });

          //create sql sting for list with new param names
          generatedSqlString += `:${newParamName},`
        }

        generatedSqlString = generatedSqlString.slice(0, -1) + ')'; //replace trailing comma with closing parenthesis.

        //replace all occurrences of original parameter name with new generated sql
        query = query.replaceAll(":" + item.name, generatedSqlString);
      }

      const result = await connection.executeMany(
        query,
        bindParameters,
        executeManyOptions,
      );

      returnItems = this.helpers.returnJsonArray(
        result as unknown as IDataObject[]
      );

    } catch (error) {
      throw new NodeOperationError(this.getNode(), error.message);
    } finally {
      if (connection) {
        try {
          await connection.close();
        } catch (error) {
          console.error(
            `OracleDB: Failed to close the database connection: ${error}`
          );
        }
      }
    }

    return this.prepareOutputData(returnItems);
  }
}

declare global {
  interface String {
    replaceAll(match: string | RegExp, replace: string): string;
  }
}

if (typeof String.prototype.replaceAll === 'undefined') {
  String.prototype.replaceAll = function (match: string | RegExp, replace: string): string {
    return this.replace(new RegExp(match, 'g'), replace);
  };
}