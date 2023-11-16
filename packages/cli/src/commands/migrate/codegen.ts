import path from 'path';
import fs from 'fs';
import { format } from 'prettier';
import {
  DB,
  AttributeDefinition,
  CollectionsDefinition,
  CollectionDefinition,
  QueryAttributeDefinition,
  schemaToJSON,
  UserTypeOptions,
  Migration,
} from '@triplit/db';
import { getMigrationsStatus } from '../../migration.js';
import { serverRequesterMiddleware } from '../../middleware/add-server-requester.js';
import { getTriplitDir } from '../../filesystem.js';
import { blue } from 'ansis/colors';
import { Command } from '../../command.js';

export default Command({
  description: 'Generates a schema file based on your current migrations',
  middleware: [serverRequesterMiddleware],
  run: async ({ ctx }) => {
    const res = await getMigrationsStatus({ ctx });
    const migrations = res.project.migrations.filter((m) => {
      const status = res.project.statuses[m.version];
      return status === 'IN_SYNC' || status === 'UNAPPLIED';
    });
    const fileContent = await schemaFileContentFromMigrations(migrations);
    await writeSchemaFile(fileContent);
  },
});

export async function writeSchemaFile(
  fileContent: string,
  options: { path?: string } = {}
) {
  const fileName = path.join(options?.path || getTriplitDir(), 'schema.ts');
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  //use prettier as a fallback for formatting
  const formatted = await format(fileContent, { parser: 'typescript' });
  fs.writeFile(fileName, formatted, 'utf8', (err) => {
    if (err) throw err;
    console.log(blue(`New schema has been saved at ${fileName}`));
  });
}

// Currently using this in tests
export async function schemaFileContentFromMigrations(migrations: Migration[]) {
  const db = new DB<any>({ migrations: migrations });
  await db.ensureMigrated;
  const schema = await db.getSchema();
  return schemaFileContentFromSchema(schema);
}

export function schemaFileContentFromSchema(
  schema:
    | {
        version: number;
        collections: any;
      }
    | undefined
) {
  const schemaJSON = schemaToJSON(schema);

  const schemaContent = collectionsDefinitionToFileContent(
    schemaJSON?.collections ?? {}
  );
  const fileContent =
    `
/**
 * This file is auto-generated by the Triplit CLI.
 */ 

import { Schema as S } from '@triplit/db';
export const schema = ${schemaContent};
      `.trim() + '\n';
  return fileContent;
}

// Generate a string representation of the schema that can be written to a file
const indentation = '  ';
export function collectionsDefinitionToFileContent(
  collectionsDefinition: CollectionsDefinition,
  indent = indentation
) {
  let result = '{\n';
  for (let collectionKey in collectionsDefinition) {
    result += indent;
    result += `'${collectionKey}': {\n`;
    const { schema: attributes, rules } = collectionsDefinition[collectionKey];
    result += generateAttributesSection(attributes, indent + indentation);
    result += generateRulesSection(rules, indent + indentation);
    result += indent + '},\n';
  }
  return result + indent.slice(0, -2) + '}';
}

function generateAttributesSection(
  schema: CollectionDefinition['schema'],
  indent: string
) {
  let result = '';
  result += indent + 'schema: S.Schema({\n';
  for (const path in schema.properties) {
    const itemInfo = schema.properties[path];
    result += generateAttributeSchema([path], itemInfo, indent + indentation);
  }
  result += indent + '}),\n';
  return result;
}

function generateRulesSection(
  rules: CollectionDefinition['rules'],
  indent: string
) {
  let result = '';
  if (rules) {
    result +=
      indent +
      `rules: ${JSON.stringify(rules, null, 2)
        .split('\n')
        .join(`\n${indent}`)}`;
  }

  return result;
}

function generateAttributeSchema(
  path: string[],
  schemaItem: AttributeDefinition,
  indent: string
) {
  if (path.length === 0) return schemaItemToString(schemaItem);
  if (path.length === 1)
    return indent + `'${path[0]}': ${schemaItemToString(schemaItem)},\n`;
  let result = '';
  const [head, ...tail] = path;
  result += indent + `'${head}': {\n`;
  result += generateAttributeSchema(tail, schemaItem, indent + indentation);
  result += indent + '},\n';
  return result;
}

// TODO: parse options
// TODO: put on type classes?
function schemaItemToString(schemaItem: AttributeDefinition): string {
  const { type } = schemaItem;
  if (type === 'string')
    return `S.String(${valueOptionsToString(schemaItem.options)})`;
  if (type === 'boolean')
    return `S.Boolean(${valueOptionsToString(schemaItem.options)})`;
  if (type === 'number')
    return `S.Number(${valueOptionsToString(schemaItem.options)})`;
  if (type === 'date')
    return `S.Date(${valueOptionsToString(schemaItem.options)})`;
  if (type === 'set') return `S.Set(${schemaItemToString(schemaItem.items)})`;
  if (type === 'record')
    return `S.Record({${Object.entries(schemaItem.properties)
      .map(([key, value]) => `'${key}': ${schemaItemToString(value as any)}`)
      .join(',\n')}})`;
  if (type === 'query') return `S.Query(${subQueryToString(schemaItem.query)})`;
  throw new Error(`Invalid type: ${type}`);
}

function valueOptionsToString(options: UserTypeOptions): string {
  const { nullable, default: defaultValue } = options;
  const result: string[] = [];
  if (nullable !== undefined) result.push(`nullable: ${nullable}`);
  if (defaultValue !== undefined)
    result.push(`default: ${defaultValueToString(defaultValue)}`);
  // wrap in braces if there are options
  if (result.length) return `{${result.join(', ')}}`;
  return '';
}

type Defined<T> = T extends undefined ? never : T;

function defaultValueToString(
  defaultValue: Defined<UserTypeOptions['default']>
): string {
  if (typeof defaultValue === 'object' && defaultValue !== null) {
    const { func, args } = defaultValue;
    // TODO: import list from db
    if (!['now', 'uuid'].includes(func))
      throw new Error('Invalid default function name');
    const parsedArgs = args ? args.map(valueToJS).join(', ') : '';
    return `S.Default.${func}(${parsedArgs})`;
  }

  return `${valueToJS(defaultValue)}`;
}

// Helpful for pulling out reserved words (ie default, return, etc)
function valueToJS(value: any) {
  if (typeof value === 'string') return `"${value}"`;
  if (typeof value === 'number') return `${value}`;
  if (typeof value === 'boolean') return `${value}`;
  if (value === null) return `null`;
  throw new Error(`Invalid value: ${value}`);
}

function subQueryToString(subquery: QueryAttributeDefinition['query']) {
  const { collectionName, where } = subquery;
  return `{collectionName: '${collectionName}', where: ${JSON.stringify(
    where
  )}}`;
}
