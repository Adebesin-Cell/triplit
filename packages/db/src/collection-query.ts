import {
  triplesToEntities,
  Entity,
  updateEntity,
  isExistsFilter,
} from './query.js';
import {
  FilterStatement,
  SubQueryFilter,
  CollectionQuery,
  QueryResultCardinality,
  QueryValue,
  RelationSubquery,
  QueryInclusion,
  RefSubquery,
} from './query/types';
import {
  isBooleanFilter,
  isSubQueryFilter,
  isFilterGroup,
  isFilterStatement,
} from './query.js';
import {
  createSchemaIterator,
  createSchemaTraverser,
  getAttributeFromSchema,
  getSchemaFromPath,
} from './schema/schema.js';
import { Model, Models } from './schema/types';
import { timestampedObjectToPlainObject } from './utils.js';
import { Timestamp, timestampCompare } from './timestamp.js';
import { TripleStore, TripleStoreApi } from './triple-store.js';
import { FilterFunc, MapFunc, Pipeline } from './utils/pipeline.js';
import { QueryNotPreparedError, TriplitError } from './errors.js';
import {
  stripCollectionFromId,
  appendCollectionToId,
  splitIdParts,
  someFilterStatements,
  isValueVariable,
  replaceVariablesInFilterStatements,
  getVariableComponents,
  isValueReferentialVariable,
  createVariable,
} from './db-helpers.js';
import { DataType, Operator } from './data-types/base.js';
import { VariableAwareCache } from './variable-aware-cache.js';
import { isTimestampedEntityDeleted } from './entity.js';
import {
  CollectionNameFromModels,
  ModelFromModels,
  SystemVariables,
} from './db.js';
import type DB from './db.js';
import { QueryType } from './data-types/query.js';
import { ExtractTimestampedType } from './data-types/type.js';
import {
  RangeContraints,
  TripleRow,
  TupleValue,
} from './triple-store-utils.js';
import { Equal } from '@sinclair/typebox/value';
import { MIN, encodeValue } from '@triplit/tuple-database';
import { QueryBuilder } from './query/builder.js';
import {
  CollectionQueryDefault,
  FetchResult,
  FetchResultEntity,
  QueryResult,
} from './query/types';
import {
  getFilterPriorityOrder,
  satisfiesFilter,
  satisfiesRegisterFilter,
  satisfiesSetFilter,
} from './query/filters.js';
import { prepareQuery } from './query/prepare.js';
import { SessionRole } from './schema/permissions.js';
import { arrToGen, genToArr, mapGen } from './utils/generator.js';

export default function CollectionQueryBuilder<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(collectionName: CN, params?: Omit<CollectionQuery<M, CN>, 'collectionName'>) {
  const query: CollectionQueryDefault<M, CN> = {
    collectionName,
    ...params,
  };
  return new QueryBuilder<M, CN>(query);
}

export type TimestampedQueryResult<
  Q extends CollectionQuery<any, any, any, any>,
  C extends QueryResultCardinality
> = C extends 'one'
  ? TimestampedFetchResultEntity<Q> | null
  : TimestampedFetchResult<Q>;

export type TimestampedFetchResult<C extends CollectionQuery<any, any>> = Map<
  string,
  TimestampedFetchResultEntity<C>
>;

type TimestampedFetchResultEntity<C extends CollectionQuery<any, any>> =
  C extends CollectionQuery<infer M, infer CN>
    ? TimestampedTypeFromModel<ModelFromModels<M, CN>>
    : never;

function getIdFilterFromQuery(query: CollectionQuery<any, any>): string | null {
  const { where, collectionName } = query;

  const idEqualityFilters = (where ?? [])
    .filter(isFilterStatement)
    .filter((filter) => filter[0] === 'id' && filter[1] === '=');

  if (idEqualityFilters.length > 0) {
    return appendCollectionToId(
      collectionName,
      idEqualityFilters[0][2] as string
    );
  }
  return null;
}

type QueryFulfillmentTracker = {
  where: boolean[];
  order: boolean[];
  after: boolean;
};

async function getOrderSetForQuery(
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  schema: Models | undefined,
  fulfilled: QueryFulfillmentTracker
) {
  const { order, after } = query;
  if (!order?.length) return undefined;
  const singleOrder = order.length === 1;
  const [firstOrderAttr, firstOrderDirection] = order[0];
  const attrPath = firstOrderAttr.split('.');
  let firstOrderHasRelation = false;
  let firstOrderUndefined = false;
  if (schema) {
    const schemaIterator = createSchemaIterator(
      attrPath,
      schema,
      query.collectionName
    );
    for (const dataType of schemaIterator) {
      if (!dataType) {
        firstOrderUndefined = true;
        break;
      }
      if (dataType.type === 'query') {
        firstOrderHasRelation = true;
        break;
      }
    }
  }
  if (!firstOrderHasRelation && !firstOrderUndefined) {
    const [cursor, inclusive] = after ?? [undefined, false];

    const gtArg = singleOrder
      ? firstOrderDirection === 'ASC'
        ? cursor
        : undefined
      : undefined;
    const ltArg = singleOrder
      ? firstOrderDirection === 'DESC'
        ? cursor
        : undefined
      : undefined;

    fulfilled.after = after ? !!gtArg || !!ltArg : true;
    fulfilled.order[0] = true;

    const rangeParams: RangeContraints = {
      direction: firstOrderDirection,
      greaterThanCursor: inclusive ? undefined : gtArg,
      greaterThanOrEqualCursor: inclusive ? gtArg : undefined,
      lessThanCursor: inclusive ? undefined : ltArg,
      lessThanOrEqualCursor: inclusive ? ltArg : undefined,
    };
    // TODO ideally we should return an async iterable here
    // instead of converting the entire result to an array
    const orderedTriples = await genToArr(
      tx.findValuesInRange([query.collectionName, ...attrPath], rangeParams)
    );
    // Only take max timestamps for each entity-attribute because there could be dupes
    const entityAttributes = new Map<string, Timestamp>();
    const entityIds = new Set<string>();
    for (let trip of orderedTriples) {
      const entityAttrStr = [trip.id, ...trip.attribute].join('-');
      if (!entityAttributes.has(entityAttrStr)) {
        entityAttributes.set(entityAttrStr, trip.timestamp);
        entityIds.add(trip.id);
      } else {
        const currentTimestamp = entityAttributes.get(entityAttrStr);
        if (timestampCompare(trip.timestamp, currentTimestamp) > 0) {
          entityAttributes.set(entityAttrStr, trip.timestamp);
          entityIds.delete(trip.id);
          entityIds.add(trip.id);
        }
      }
    }
    return entityIds.values();
  }
  return undefined;
}

function getFilterSetForQuery(
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  schema: Models | undefined,
  fulfilled: QueryFulfillmentTracker
): AsyncIterable<string> | undefined {
  const { where } = query;
  const [filterIdx, filterType, dataType] = findCandidateFilter(query, schema);
  if (filterIdx === -1) return undefined;
  const filterMatch = where![filterIdx] as FilterStatement<any, any>;
  if (filterType === 'range') {
    fulfilled.where[filterIdx] = true;
    let rangePair: FilterStatement<any, any> | undefined = undefined;
    const rangePairIndex = findRangeFilter(
      query,
      filterMatch[0],
      filterIdx,
      GT_OPS.includes(filterMatch[1]) ? 'lt' : 'gt'
    );
    if (rangePairIndex !== -1) {
      rangePair = where![rangePairIndex] as FilterStatement<any, any>;
      fulfilled.where[rangePairIndex] = true;
    }
    return mapGen(
      performRangeScan(tx, query, [filterMatch, rangePair]),
      (t) => t.id
    );
    return;
  }
  if (filterType === 'equality') {
    // Not used yet, i think some parts of AVE scan imply we still need to re-evaluate the filter
    fulfilled.where[filterIdx] = true;
    return mapGen(
      performEqualityScan(tx, query, filterMatch, dataType),
      (t) => t.id
    );
  }

  return undefined;
}

// get one range filter, search for other
// perform query within range
const EQUALITY_OPS = ['='];
const GT_OPS = ['>', '>='];
const LT_OPS = ['<', '<='];
const RANGE_OPS = [...GT_OPS, ...LT_OPS] as const;

async function* performRangeScan<
  M extends Models,
  Q extends CollectionQuery<M, any>
>(
  tx: TripleStoreApi,
  query: Q,
  filters: [FilterStatement<M, any>, FilterStatement<M, any> | undefined]
) {
  const { collectionName } = query;
  const [filter, rangePair] = filters;
  const attribute = filter[0].split('.');

  const gtFilter = GT_OPS.includes(filter[1]) ? filter : rangePair;
  const ltFilter = LT_OPS.includes(filter[1]) ? filter : rangePair;

  const rangeParams: RangeContraints = {
    greaterThan:
      gtFilter?.[1] === '>'
        ? safeFilterRangeConstraint(gtFilter[2])
        : undefined,
    greaterThanOrEqual:
      gtFilter?.[1] === '>='
        ? safeFilterRangeConstraint(gtFilter[2])
        : undefined,
    lessThan:
      ltFilter?.[1] === '<'
        ? safeFilterRangeConstraint(ltFilter[2])
        : undefined,
    lessThanOrEqual:
      ltFilter?.[1] === '<='
        ? safeFilterRangeConstraint(ltFilter[2])
        : undefined,
  };

  yield* tx.findValuesInRange([collectionName, ...attribute], rangeParams);
}

// TODO: move this to data types, similar hack as compareCursors
function safeFilterRangeConstraint(value: QueryValue): TupleValue {
  // if value is date, convert to timestamp
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value))
    return JSON.stringify(value.map(safeFilterRangeConstraint));
  return value;
}

async function* performEqualityScan<
  M extends Models,
  Q extends CollectionQuery<M, any>
>(
  tx: TripleStoreApi,
  query: Q,
  filter: FilterStatement<M, any>,
  dataType: DataType | undefined
): AsyncGenerator<TripleRow> {
  if (dataType?.type === 'query' || dataType?.type === 'record') return [];
  if (dataType?.type === 'set') {
    yield* performSetEqualityScan(tx, query, filter);
    return;
  }
  yield* performValueEqualityScan(tx, query, filter);
  return;
}

function findRangeFilter(
  query: CollectionQuery<any, any>,
  path: string,
  after: number,
  type: 'gt' | 'lt'
) {
  const { where } = query;
  if (!where) return -1;
  for (let i = after + 1; i < where.length; i++) {
    const filter = where[i];
    if (isBooleanFilter(filter)) continue;
    if (isSubQueryFilter(filter)) continue;
    if (isFilterGroup(filter)) continue;
    if (isExistsFilter(filter)) continue;
    const [filterPath, op, value] = filter;
    if (filterPath === path) {
      if (type === 'gt' && GT_OPS.includes(op)) return i;
      if (type === 'lt' && LT_OPS.includes(op)) return i;
    }
  }
  return -1;
}

function findCandidateFilter(
  query: CollectionQuery<any, any>,
  schema: Models | undefined
):
  | [-1, undefined, undefined]
  | [idx: number, 'equality' | 'range', dataType: DataType | undefined] {
  const { where, collectionName } = query;
  function getCandidateDataTypeFromPath(
    path: string,
    schema: Models | undefined,
    collectionName: string
  ): DataType | undefined {
    if (!schema) return undefined;
    const dataType = getAttributeFromSchema(
      path.split('.'),
      schema,
      collectionName as any
    );
    if (!dataType) return undefined;
    if (dataType.type === 'query' || dataType.type === 'record')
      return undefined;
    return dataType;
  }

  if (where) {
    for (let i = 0; i < where.length; i++) {
      const filter = where[i];
      if (isBooleanFilter(filter)) continue;
      if (isSubQueryFilter(filter)) continue;
      if (isFilterGroup(filter)) continue;
      if (isExistsFilter(filter)) continue;
      const [path, op, value] = filter;
      if (EQUALITY_OPS.includes(op)) {
        return [
          i,
          'equality',
          getCandidateDataTypeFromPath(path, schema, collectionName),
        ];
      }
      if (RANGE_OPS.includes(op)) {
        return [
          i,
          'range',
          getCandidateDataTypeFromPath(path, schema, collectionName),
        ];
      }
    }
  }
  return [-1, undefined, undefined];
}

async function* performValueEqualityScan(
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  filter: FilterStatement<any, any>
) {
  yield* tx.findByAVE([
    [query.collectionName, ...filter[0].split('.')],
    // @ts-expect-error
    filter[2],
  ]);
}

async function* performSetEqualityScan(
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  filter: FilterStatement<any, any>
) {
  yield* tx.findByAVE([
    [query.collectionName, ...filter[0].split('.'), filter[2]],
    true,
  ]);
}

export function getCollectionIds(
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>
) {
  return mapGen(
    tx.findByAVE([['_collection'], query.collectionName]),
    (t) => t.id
  );
}

export async function getCandidateEntityIds(
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  options: FetchFromStorageOptions = {}
): Promise<{
  candidates: AsyncIterable<string> | Iterable<string>;
  fulfilled: QueryFulfillmentTracker;
}> {
  const { schema, skipIndex } = options;
  const fulfilled: QueryFulfillmentTracker = {
    where: query.where ? new Array(query.where.length).fill(false) : [],
    order: query.order ? new Array(query.order.length).fill(false) : [],
    after: !query.after,
  };

  if (!skipIndex) {
    const entityId = getIdFilterFromQuery(query);
    if (entityId) {
      return { candidates: arrToGen([entityId]), fulfilled };
    }

    const filterSet = getFilterSetForQuery(tx, query, schema, fulfilled);
    if (filterSet) {
      return { candidates: filterSet, fulfilled };
    }

    const orderSet = await getOrderSetForQuery(tx, query, schema, fulfilled);
    if (orderSet) {
      return { candidates: orderSet, fulfilled };
    }

    // TODO: evaluate performing both order and filter scans
    // Initial observations are that order scans are slow / longer, should investigate further
  }
  return {
    candidates: getCollectionIds(tx, query),
    fulfilled,
  };
}

function identifierIncludesRelation<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(identifier: string, schema: M, collectionName: CN) {
  return !!getRelationPathsFromIdentifier(identifier, schema, collectionName)
    .length;
}

export function getRelationsFromIdentifier<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(
  identifier: string,
  schema: M,
  collectionName: CN
): Record<string, QueryType<any, any, any>> {
  let schemaTraverser = createSchemaTraverser(schema, collectionName);
  const attrPath = identifier.split('.');
  const relationPath: string[] = [];
  const relations: Record<string, QueryType<any, any, any>> = {};
  for (const attr of attrPath) {
    relationPath.push(attr);
    schemaTraverser = schemaTraverser.get(attr);
    if (schemaTraverser.current?.type === 'query') {
      relations[relationPath.join('.')] = schemaTraverser.current;
    }
  }
  return relations;
}
export function getRelationPathsFromIdentifier<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(identifier: string, schema: M, collectionName: CN): string[] {
  return Object.keys(
    getRelationsFromIdentifier(identifier, schema, collectionName)
  );
}

function getRootRelationAlias<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(identifier: string, schema: M, collectionName: CN) {
  let schemaTraverser = createSchemaTraverser(schema, collectionName);
  const attrPath = identifier.split('.');
  const relationPath: string[] = [];
  for (const attr of attrPath) {
    schemaTraverser = schemaTraverser.get(attr);
    relationPath.push(attr);
    if (schemaTraverser.current?.type === 'query') {
      return relationPath.join('.');
    }
  }
  return undefined;
}

function groupIdentifiersBySubquery<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(identifiers: string[], schema: M, collectionName: CN) {
  const groupedIdentifiers: Record<string, Set<string>> = {};
  for (const identifier of identifiers) {
    const relations = getRelationPathsFromIdentifier(
      identifier,
      schema,
      collectionName
    );
    if (!relations.length) continue;
    // Root should be the first relation in the traversal
    const rootRelation = relations.shift()!;
    if (!groupedIdentifiers[rootRelation]) {
      groupedIdentifiers[rootRelation] = new Set();
    }
    for (let relation of relations) {
      // remove rootRelation from relation
      relation = relation.slice(rootRelation.length + 1);
      // add to groupedIdentifiers
      groupedIdentifiers[rootRelation].add(relation);
    }
  }
  return groupedIdentifiers;
}

function getEntitiesAtStateVector(
  collectionTriples: TripleRow[],
  stateVector?: Map<string, number>
) {
  return triplesToEntities(
    collectionTriples,
    stateVector && stateVector.size > 0 ? stateVector : undefined
  );
}

async function getTriplesAfterStateVector(
  tx: TripleStoreApi,
  stateVector: Map<string, number>
): Promise<TripleRow[]> {
  const allTriples: TripleRow[] = [];
  const allClientIds = await tx.findAllClientIds();
  const completeStateVector = new Map<string, number>(
    allClientIds.map((clientId) => [clientId, stateVector.get(clientId) ?? 0])
  );
  for (const [clientId, tick] of completeStateVector) {
    const triples = await genToArr(
      tx.findByClientTimestamp(clientId, 'gt', [tick, clientId])
    );
    for (const triple of triples) {
      allTriples.push(triple);
    }
  }
  return allTriples;
}

export async function fetchDeltaTriples<
  M extends Models,
  Q extends CollectionQuery<M, any>
>(
  caller: DB<M>,
  tx: TripleStoreApi,
  query: Q,
  newTriples: TripleRow[],
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions = {}
) {
  const queryPermutations = generateQueryRootPermutations(
    await replaceVariablesInQuery(caller, tx, query, executionContext, options) // TODO: subquery vars
  );

  const changedEntityTriples = newTriples.reduce((entities, trip) => {
    if (!entities.has(trip.id)) {
      entities.set(trip.id, []);
    }
    entities.get(trip.id)!.push(trip);
    return entities;
  }, new Map<string, TripleRow[]>());
  const deltaTriples: TripleRow[] = [];

  // this is kinda weird but we're actually creating the state vector that would be
  // before these changed triples so it's looking for the min timestamp rather than
  // the max
  const stateVector = newTriples.reduce<Map<string, number>>((acc, curr) => {
    const [tick, clientId] = curr.timestamp;
    if (!acc.has(clientId) || tick < acc.get(clientId)! + 1) {
      acc.set(clientId, Math.max(tick - 1, 0));
    }
    return acc;
  }, new Map());
  for (const changedEntityId of changedEntityTriples.keys()) {
    const entityTriples = await genToArr(tx.findByEntity(changedEntityId));
    const entityBeforeStateVector = getEntitiesAtStateVector(
      entityTriples,
      stateVector
    ).get(changedEntityId)?.data;
    const entityAndTriplesAfterStateVector =
      getEntitiesAtStateVector(entityTriples).get(changedEntityId);
    const entityAfterStateVector = entityAndTriplesAfterStateVector?.data;

    for (const queryPermutation of queryPermutations) {
      if (
        queryPermutation.collectionName !== splitIdParts(changedEntityId)[0]
      ) {
        continue;
      }
      const matchesSimpleFiltersBefore =
        !!entityBeforeStateVector &&
        doesEntityObjMatchBasicWhere(
          entityBeforeStateVector,
          queryPermutation.where,
          options.schema &&
            options.schema[queryPermutation.collectionName]?.schema
        );
      const matchesSimpleFiltersAfter =
        !!entityAfterStateVector &&
        doesEntityObjMatchBasicWhere(
          entityAfterStateVector,
          queryPermutation.where,
          options.schema &&
            options.schema[queryPermutation.collectionName]?.schema
        );
      if (!matchesSimpleFiltersBefore && !matchesSimpleFiltersAfter) {
        continue;
      }

      const subQueries = (queryPermutation.where ?? []).filter((filter) =>
        isSubQueryFilter(filter)
      ) as SubQueryFilter<M>[];
      let matchesBefore = matchesSimpleFiltersBefore;
      if (matchesSimpleFiltersBefore && subQueries.length > 0) {
        for (const { exists: subQuery } of subQueries) {
          const { results: subQueryResult } = await loadSubquery(
            caller,
            tx,
            queryPermutation,
            subQuery,
            'one',
            executionContext,
            options,
            entityBeforeStateVector
          );
          if (subQueryResult === null) {
            matchesBefore = false;
            continue;
          }
        }
      }
      const afterTriplesMatch = [];
      let matchesAfter = matchesSimpleFiltersAfter;
      if (matchesSimpleFiltersAfter && subQueries.length > 0) {
        for (const { exists: subQuery } of subQueries) {
          const subQueryResult = await loadSubquery(
            caller,
            tx,
            queryPermutation,
            subQuery,
            'one',
            executionContext,
            options,
            entityAfterStateVector
          );
          if (subQueryResult.results === null) {
            matchesAfter = false;
            continue;
          }
          for (const tripleSet of subQueryResult.triples.values()) {
            for (const triple of tripleSet) {
              afterTriplesMatch.push(triple);
            }
          }
        }
      }

      if (!matchesBefore && !matchesAfter) {
        continue;
      }

      if (!matchesBefore) {
        if (subQueries.length === 0) {
          // Basically where including the whole entity if it is new to the result set
          // but we also want to filter any triples that will be included in the
          // final step of adding changed triples for the given entity
          // An example is if we insert a net new entity it will not match before
          // so it need's the whole entity to be sent but that will fully overlap
          // with the last step.
          const alreadyIncludedTriples =
            changedEntityTriples.get(changedEntityId)!;
          const tripleKeys = new Set(
            alreadyIncludedTriples.map(
              (t) =>
                t.id + JSON.stringify(t.attribute) + JSON.stringify(t.timestamp)
            )
          );
          const trips = Object.values(entityAndTriplesAfterStateVector!.triples)
            .flat()
            .filter(
              (t) =>
                !tripleKeys.has(
                  t.id +
                    JSON.stringify(t.attribute) +
                    JSON.stringify(t.timestamp)
                )
            );
          for (const triple of trips) {
            afterTriplesMatch.push(triple);
          }
        }
        for (const triple of afterTriplesMatch) {
          deltaTriples.push(triple);
        }
      }
      for (const triple of changedEntityTriples.get(changedEntityId)!) {
        deltaTriples.push(triple);
      }
    }
  }
  return deltaTriples;
}

/**
 * This takes a relational query (i.e. has sub-queries in `where` or `select`) and generates all permutations of the query where each sub-query is written as the root query.
 * In a sense it reverses the direction of the relation.
 * E.g. If the query is like "Users with posts created in the last week" it will generate permutations like "Posts created in the last week with their users"
 * @param query The query to generate permutations for
 */
export function generateQueryRootPermutations(
  query: CollectionQuery<any, any>
) {
  const queries = [];
  for (const chain of generateQueryChains(query)) {
    queries.push(queryChainToQuery(chain.slice().reverse()));
  }
  return queries;
}

/**
 * This takes a list of queries and builds up a query where
 * each query implicit depends on the next query
 * each query at pos 0 will have add an exists filter to the next query
 * @param chain
 */
function queryChainToQuery(
  chain: CollectionQuery<any, any>[],
  additionalFilters: FilterStatement<any, any>[] = []
): CollectionQuery<any, any> {
  const [first, ...rest] = chain;
  if (rest.length === 0)
    return {
      ...first,
      where: [...(first.where ?? []), ...additionalFilters],
    };
  const refVariableFilters = (first.where ?? [])
    .filter(isFilterStatement)
    .filter((filter) => isValueReferentialVariable(filter[2]));
  const nonRefVariableFilters = (first.where ?? [])
    .filter(isFilterStatement)
    .filter((filter) => !isValueReferentialVariable(filter[2]));
  const next = queryChainToQuery(
    rest,
    refVariableFilters.map(reverseRelationFilter)
  );
  return {
    ...first,
    where: [
      ...nonRefVariableFilters,
      ...additionalFilters,
      {
        exists: next,
      },
    ],
  };
}

function* generateQueryChains(
  query: CollectionQuery<any, any>,
  prefix: CollectionQuery<any, any>[] = []
): Generator<CollectionQuery<any, any>[]> {
  yield [...prefix, query];
  const subQueryFilters = (query.where ?? []).filter((filter) =>
    isSubQueryFilter(filter)
  ) as SubQueryFilter<any>[];
  const subQueryInclusions = Object.values(query.include ?? {}).reduce<
    RelationSubquery<any, any, any>[]
  >((acc, inc) => {
    if (isQueryInclusionSubquery(inc)) {
      acc.push(inc);
    } else {
      throw new QueryNotPreparedError('An inclusion is not prepared');
    }
    return acc;
  }, []);
  const subQueries = [
    ...subQueryFilters.map((f) => f.exists),
    ...subQueryInclusions.map((i) => i.subquery),
  ];
  for (const subQuery of subQueries) {
    // yield [query, subQuery] as const;
    const queryWithoutSubQuery = {
      ...query,
      where: (query.where ?? []).filter(
        (f) => !isSubQueryFilter(f) || f.exists !== subQuery
      ),
    };
    yield* generateQueryChains(subQuery, [...prefix, queryWithoutSubQuery]);
  }
}

const REVERSE_OPERATOR_MAPPINGS = {
  '=': '=',
  '!=': '!=',
  '<': '>',
  '>': '<',
  '<=': '>=',
  '>=': '<=',
  in: 'has',
  nin: '!has',
  has: 'in',
  '!has': 'nin',
};
function reverseRelationFilter(filter: FilterStatement<any, any>) {
  const [path, op, value] = filter;
  if (!isValueReferentialVariable(value)) {
    throw new TriplitError(
      `Expected filter value to be a relation variable, but got ${value}`
    );
  }
  const [scope, key] = getVariableComponents(value);
  return [
    key,
    // @ts-expect-error
    REVERSE_OPERATOR_MAPPINGS[op],
    createVariable(scope, path),
  ] as FilterStatement<any, any>;
}

export type QueryPipelineData = {
  entity: any;
  triples: TripleRow[];
  relationships: Record<string, TripleRow[]>;
  existsFilterTriples: TripleRow[];
};

function LoadCandidateEntities(
  tx: TripleStoreApi
): MapFunc<string, [string, QueryPipelineData]> {
  return async (id) => {
    const entityTriples = await genToArr(tx.findByEntity(id));
    const entity = triplesToEntities(entityTriples).get(id)?.data;
    const externalId = stripCollectionFromId(id);
    return [
      externalId,
      {
        triples: entityTriples,
        entity,
        relationships: {},
        existsFilterTriples: [],
      },
    ];
  };
}

function ApplyFilters(
  db: DB<any>,
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions
): FilterFunc<[string, QueryPipelineData]> {
  const { where } = query;

  // Apply filters in order of priority (if a filter is faster to run we'll run that first)
  const filterOrder = getFilterPriorityOrder(query);

  return async ([id, pipelineItem]) => {
    const { entity } = pipelineItem;
    if (!entity) return false;
    if (!where) return true;

    // Must satisfy all filters for inclusion
    for (const filterIdx of filterOrder) {
      const filter = where[filterIdx];
      const satisfied = await satisfiesFilter(
        db,
        tx,
        query,
        executionContext,
        options,
        pipelineItem,
        filter
      );
      if (!satisfied) return false;
    }
    return true;
  };
}

// Assumes ordered fully
// Unless we
function FilterAfterCursor(
  query: CollectionQuery<any, any>
): FilterFunc<[string, QueryPipelineData]> {
  const { order, after, collectionName } = query;
  let cursorValueReached = false;
  let cursorValuePassed = false;
  let idReached = false;
  return async ([id, { entity }]) => {
    if (!after) return true;
    const [cursor, inclusive] = after;
    if ((cursorValueReached && idReached) || cursorValuePassed) return true;
    // TODO: properly handle no order by clause
    const [orderAttr, orderDir] =
      order && order.length > 0 ? order[0] : ['id', 'ASC'];
    const entityVal = entity[orderAttr][0];
    const [cursorVal, cursorId] = cursor;
    const encodedCursorVal = encodeValue(cursorVal);
    const encodedEntityVal = encodeValue(entityVal);

    if (encodedEntityVal === encodedCursorVal) {
      cursorValueReached = true;
      const storeId = appendCollectionToId(collectionName, id);
      if (storeId === cursorId) {
        idReached = true;
      }
    } else if (
      orderDir === 'ASC'
        ? encodedEntityVal > encodedCursorVal
        : encodedEntityVal < encodedCursorVal
    ) {
      cursorValuePassed = true;
    }

    // If inclusive, return immediately
    return (
      inclusive && ((cursorValueReached && idReached) || cursorValuePassed)
    );
  };
}

// TODO: Handle relationships inside record or disallow that
// TODO: Handle conflicting includes statements
function loadOrderRelationships(
  caller: DB<any>,
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions
): MapFunc<[string, QueryPipelineData], [string, QueryPipelineData]> {
  const { order, collectionName } = query;
  const { schema, skipRules, cache, stateVector } = options;

  const subqueryIncludeGroups = schema
    ? groupIdentifiersBySubquery(
        (order ?? []).map((c) => c[0]),
        schema,
        collectionName
      )
    : {};

  return async ([
    entId,
    { entity, relationships, triples, existsFilterTriples },
  ]) => {
    if (!Object.keys(subqueryIncludeGroups).length)
      return [entId, { entity, relationships, triples, existsFilterTriples }];
    for (const [relationRoot, includedRelations] of Object.entries(
      subqueryIncludeGroups
    )) {
      // If we have already loaded this relationship, skip
      if (!!relationships[relationRoot]) continue;
      const relationship = schema
        ? getAttributeFromSchema(
            relationRoot.split('.'),
            schema,
            query.collectionName
          )
        : undefined;

      if (!relationship || relationship?.type !== 'query') {
        throw new TriplitError(
          `Could not find relationship info for ${relationRoot} in the schema.`
        );
      }

      const relationshipQuery = relationship.query;
      // TODO: this might confict with query includes
      // TODO: handle inclusions in loadSubquery
      const inclusions = Array.from(includedRelations.values()).reduce<
        Record<string, null>
      >((inc, rel) => {
        inc[rel] = null;
        return inc;
      }, {});
      let fullSubquery = {
        ...relationshipQuery,
        include: { ...(relationshipQuery.include ?? {}), ...inclusions },
      } as CollectionQuery<any, any>;
      const subqueryResult = await loadSubquery(
        caller,
        tx,
        query,
        fullSubquery,
        relationship.cardinality,
        executionContext,
        options,
        entity
      );

      // TODO: technically we should handle a relationship inside a record type...like I think thats possible
      entity[relationRoot] = subqueryResult.results;
      relationships[relationRoot] = Array.from(
        subqueryResult.triples.values()
      ).flat();
    }
    return [entId, { entity, relationships, triples, existsFilterTriples }];
  };
}

function LoadIncludeRelationships(
  caller: DB<any>,
  tx: TripleStoreApi,
  query: CollectionQuery<any, any>,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions
): MapFunc<[string, QueryPipelineData], [string, QueryPipelineData]> {
  const { include } = query;
  const subqueries = Object.entries(include ?? {});
  return async ([
    entId,
    { entity, relationships, triples, existsFilterTriples },
  ]) => {
    for (const [attributeName, inclusion] of subqueries) {
      if (!isQueryInclusionSubquery(inclusion)) {
        throw new QueryNotPreparedError('An inclusion is not prepared');
      }
      const { subquery, cardinality } = inclusion;
      // If we have already loaded this relationship, skip
      if (!!relationships[attributeName]) continue;
      const subqueryResult = await loadSubquery(
        caller,
        tx,
        query,
        subquery,
        cardinality,
        executionContext,
        options,
        entity
      );
      // TODO: handle deep
      entity[attributeName] = subqueryResult.results;
      relationships[attributeName] = Array.from(
        subqueryResult.triples.values()
      ).flat();
    }

    return [entId, { entity, triples, relationships, existsFilterTriples }];
  };
}

function bumpSubqueryVars(vars: Record<string, any>) {
  return Object.entries(vars).reduce<Record<string, any>>((acc, [key, val]) => {
    acc[bumpSubqueryVar(key)] = val;
    return acc;
  }, {});
}

export function bumpSubqueryVar(varName: string) {
  const splitIdx = varName.indexOf('.');
  if (splitIdx === -1) {
    // For backwards compatability we just return the varName if it doesn't have a prefix
    // If we enforce prefixing, we should throw an error here
    // throw new Error('var missing prefix: ' + varName);
    return varName;
  }
  const [prefix, rest] = [
    varName.slice(0, splitIdx),
    varName.slice(splitIdx + 1),
  ];
  const intPrefix = parseInt(prefix);
  if (isNaN(intPrefix)) return varName;
  return `${intPrefix + 1}.${rest}`;
}

export async function loadSubquery(
  caller: DB<any>,
  tx: TripleStoreApi,
  parentQuery: CollectionQuery<any, any>,
  subquery: CollectionQuery<any, any>,
  cardinality: QueryResultCardinality,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions,
  entity: any
) {
  const { schema } = options;

  // Get parent entity variables
  const entityVars = extractSubqueryVarsFromEntity(
    entity,
    schema,
    parentQuery.collectionName
  );

  // Push entity onto context stack
  executionContext.queriedDataStack = [
    ...executionContext.queriedDataStack,
    entityVars,
  ];

  // Merge query variables (this could also be scoped if needed)
  let fullSubquery = {
    ...subquery,
    vars: { ...(parentQuery.vars ?? {}), ...(subquery.vars ?? {}) },
  } as CollectionQuery<any, any>;

  fullSubquery = prepareQuery(
    fullSubquery,
    schema,
    { roles: caller.sessionRoles },
    {
      skipRules: options.skipRules,
    }
  );

  // Perform fetch
  const result =
    cardinality === 'one'
      ? await fetchOne(caller, tx, fullSubquery, executionContext, options)
      : await fetch(caller, tx, fullSubquery, executionContext, options);

  // Remove entity from context stack
  // I think this is safe, but be careful this reference is shared through the query execution
  executionContext.queriedDataStack.pop();
  return result;
}

export type FetchFromStorageOptions = {
  schema?: Models;
  skipRules?: boolean;
  cache?: VariableAwareCache<any>;
  stateVector?: Map<string, number>;
  skipIndex?: boolean;
};

export type FetchExecutionContext = {
  queriedDataStack: any[];
};

export function initialFetchExecutionContext(): FetchExecutionContext {
  return {
    queriedDataStack: [],
  };
}

function isSystemKey(key: string) {
  return key === '_collection';
}

/**
 * fetch
 * @summary This function is used to fetch entities from the database. It can be used to fetch a single entity or a collection of entities.
 * @description This function tries to consult TripleStore indexes to efficiently fetch entities. If the query is not supported by the indexes, it will fall back to scanning the entire database.
 * This can happen for queries that use multiple order clauses, LIKE filters, etc.
 * @param tx
 * @param query
 * @param options
 */
export async function fetch<
  M extends Models,
  Q extends CollectionQuery<M, any>
>(
  caller: DB<M>,
  tx: TripleStoreApi,
  query: Q,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions = {}
): Promise<{
  results: TimestampedFetchResult<Q>;
  triples: Map<string, TripleRow[]>;
}> {
  const { schema, cache } = options;
  const collectionSchema = schema?.[query.collectionName]?.schema;
  if (cache && VariableAwareCache.canCacheQuery(query, collectionSchema)) {
    return cache!.resolveFromCache(
      query,
      caller.systemVars,
      executionContext,
      options
    );
  }
  const queryWithInsertedVars = await replaceVariablesInQuery(
    caller,
    tx,
    query,
    executionContext,
    options
  );
  const { order, limit, select, where, collectionName, after } =
    queryWithInsertedVars;

  // Load possible entity ids from indexes
  // TODO lazy load as needed using a cursor or iterator rather than loading entire index at once
  const { candidates, fulfilled: clausesFulfilled } =
    await getCandidateEntityIds(tx, queryWithInsertedVars, options);

  const resultTriples: Map<string, TripleRow[]> = new Map();

  let pipeline = new Pipeline<string>()
    .map(LoadCandidateEntities(tx))
    // Apply where filters
    // TODO: dont refilter if already applied
    .filter(
      ApplyFilters(caller, tx, queryWithInsertedVars, executionContext, options)
    )
    // Capture entity triples
    .tap(async ([id, { triples }]) => {
      if (!resultTriples.has(id)) {
        resultTriples.set(id, triples as TripleRow[]);
      } else {
        resultTriples.set(id, resultTriples.get(id)!.concat(triples));
      }
    })
    // We need to make sure that all the triples are accounted for before we filter out deleted entities
    .filter(async ([, { entity }]) => !isTimestampedEntityDeleted(entity));

  if (order && !clausesFulfilled.order.every((f) => f)) {
    pipeline = pipeline
      .map(loadOrderRelationships(caller, tx, query, executionContext, options))
      .sort(([_aId, { entity: aEntity }], [_bId, { entity: bEntity }]) =>
        querySorter(query)(aEntity, bEntity)
      );
  }

  // After filter algorithm requires that we have sorted the entities
  if (after && !clausesFulfilled.after) {
    pipeline = pipeline.filter(FilterAfterCursor(query));
    clausesFulfilled.after = true;
  }

  if (limit) {
    pipeline = pipeline.take(limit);
  }

  if (
    !select ||
    select.length > 0 ||
    (query.include && Object.keys(query.include).length > 0)
  ) {
    // Load include relationships
    pipeline = pipeline
      .map(
        LoadIncludeRelationships(caller, tx, query, executionContext, options)
      )
      .map(
        async ([
          entId,
          { entity, relationships, triples, existsFilterTriples },
        ]) => {
          const selectedAttributes: string[] = select
            ? (select as unknown as string[]) // If we have a selection use that
            : schema && query.collectionName !== '_metadata'
            ? Object.entries(schema[query.collectionName].schema.properties)
                .filter(([_key, dataType]) => dataType.type !== 'query')
                .map(([key]) => key) // If schema, use those props
            : // If schemaless, use any props queried, without system keys
              Object.keys(entity).filter((key) => !isSystemKey(key));
          const includedRelationships = Object.keys(query.include ?? {});
          const selectedEntity = selectedAttributes
            .concat(includedRelationships)
            .reduce<any>(selectParser(entity), {});

          return [
            entId,
            {
              entity: selectedEntity,
              relationships,
              triples,
              existsFilterTriples,
            },
          ];
        }
      );
  }

  pipeline = pipeline
    .tap(([id, { relationships, existsFilterTriples }]) => {
      if (!resultTriples.has(id)) {
        resultTriples.set(id, []);
      }
      for (const relTriples of Object.values(relationships)) {
        resultTriples.set(id, resultTriples.get(id)!.concat(relTriples));
      }
      resultTriples.set(id, resultTriples.get(id)!.concat(existsFilterTriples));
    })
    .map<[string, any]>(([id, { entity }]) => [id, entity]);

  // @ts-expect-error
  const entities: [string, any][] | AsyncGenerator<[string, any]> = await (
    pipeline as Pipeline<string, [string, any]>
  ).run(candidates);

  const entitiesArr =
    entities instanceof Array ? entities : await genToArr(entities);
  return {
    results: new Map(entitiesArr),
    triples: resultTriples,
  };
}

// Entities are have db values
// This can be probably be faster if we know we are partially sorted already
function sortEntities(
  query: CollectionQuery<any, any>,
  entities: [string, any][]
) {
  if (!query.order) return;
  entities.sort((a, b) => querySorter(query)(a[1], b[1]));
}

function querySorter(query: CollectionQuery<any, any>) {
  return (a: any, b: any) => {
    for (const [prop, dir] of query.order!) {
      const valueA = getPropertyFromPath(a, prop.split('.'))?.[0];
      const valueB = getPropertyFromPath(b, prop.split('.'))?.[0];
      const encodedA = encodeValue(valueA ?? MIN);
      const encodedB = encodeValue(valueB ?? MIN);
      const direction = encodedA < encodedB ? -1 : encodedA > encodedB ? 1 : 0;
      if (direction !== 0) return dir === 'ASC' ? direction : direction * -1;
    }
    return 0;
  };
}

// Expect that data is already loaded on entity
function getPropertyFromPath(entity: any, path: string[]) {
  return path.reduce((acc, key) => acc[key], entity);
}

export async function fetchOne<
  M extends Models,
  Q extends CollectionQuery<M, any>
>(
  caller: DB<M>,
  tx: TripleStoreApi,
  query: Q,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions = {}
): Promise<{
  results: TimestampedQueryResult<Q, 'one'>;
  triples: Map<string, TripleRow[]>;
}> {
  query = { ...query, limit: 1 };
  const fetchResult = await fetch(caller, tx, query, executionContext, options);
  const { results, triples } = fetchResult;
  return {
    results: [...results.values()][0] ?? null,
    triples,
  };
}

// NOTE: this only matches simple filters, not relational
// TODO: evaluate proper handling of relational filters
export function doesEntityObjMatchBasicWhere<
  Q extends CollectionQuery<any, any>
>(entityObj: any, where: Q['where'], schema?: CollectionQuerySchema<Q>) {
  if (!where) return true;
  const basicStatements = where.filter(isFilterStatement);

  const orStatements = where
    .filter(isFilterGroup)
    .filter((f) => f.mod === 'or');

  const andStatements = where
    .filter(isFilterGroup)
    .filter((f) => f.mod === 'and');

  const matchesBasicFilters = entitySatisfiesAllFilters(
    entityObj,
    basicStatements,
    schema
  );

  if (!matchesBasicFilters) return false;

  const matchesOrFilters = orStatements.every(({ filters }) =>
    filters.some((filter) =>
      doesEntityObjMatchBasicWhere(entityObj, [filter], schema)
    )
  );
  if (!matchesOrFilters) return false;

  const matchesAndFilters = andStatements.every(({ filters }) =>
    doesEntityObjMatchBasicWhere(entityObj, filters, schema)
  );
  if (!matchesAndFilters) return false;

  return true;
}
/**
 *
 * @param entity An entity object
 * @param filters Simple statements (not AND or OR)
 * @returns boolean
 */
function entitySatisfiesAllFilters(
  entity: any,
  filters: FilterStatement<any, any>[],
  schema?: Model
): boolean {
  const groupedFilters: Map<string, [Operator, any][]> = filters.reduce(
    (groups, statement) => {
      const [path, op, value] = statement;
      if (groups.has(path)) {
        groups.get(path).push([op, value]);
      } else {
        groups.set(path, [[op, value]]);
      }
      return groups;
    },
    new Map()
  );
  return (
    groupedFilters.size === 0 ||
    [...groupedFilters.entries()].every(([path, filters]) => {
      const dataType = schema && getSchemaFromPath(schema, path.split('.'));
      return filters.every(([op, filterValue]) => {
        // If we have a schema handle specific cases
        if (dataType && dataType.type === 'set') {
          return satisfiesSetFilter(entity, path, op, filterValue);
        }
        // Use register as default
        return satisfiesRegisterFilter(entity, path, op, filterValue);
      });
    })
  );
}

export type CollectionQuerySchema<Q extends CollectionQuery<any, any>> =
  Q extends CollectionQuery<infer M, infer CN> ? ModelFromModels<M, CN> : never;

export function subscribeResultsAndTriples<
  M extends Models,
  Q extends CollectionQuery<M>
>(
  caller: DB<M>,
  tripleStore: TripleStore,
  query: Q,
  onResults: (
    args: [results: FetchResult<M, Q>, newTriples: Map<string, TripleRow[]>]
  ) => void | Promise<void>,
  onError?: (error: any) => void | Promise<void>,
  options: FetchFromStorageOptions = {}
) {
  const { select, order, limit, include } = query;
  const executionContext = initialFetchExecutionContext();
  const asyncUnSub = async () => {
    let results: TimestampedFetchResult<Q> = new Map();
    let triples: Map<string, TripleRow[]> = new Map();
    let unsub = () => {};
    try {
      const fetchResult = await fetch<M, Q>(
        caller,
        tripleStore,
        query,
        executionContext,
        options
      );
      results = fetchResult.results;
      triples = fetchResult.triples;

      const { where } = await replaceVariablesInQuery(
        caller,
        tripleStore,
        query,
        executionContext,
        options
      );

      unsub = tripleStore.onWrite(async (storeWrites) => {
        try {
          // Handle queries with nested queries as a special case for now
          if (
            (where &&
              someFilterStatements(where, (filter) =>
                isSubQueryFilter(filter)
              )) ||
            (include && Object.keys(include).length > 0) ||
            (order &&
              order.some(
                (o) =>
                  options.schema &&
                  identifierIncludesRelation(
                    o[0],
                    options.schema,
                    query.collectionName
                  )
              ))
          ) {
            const fetchResult = await fetch<M, Q>(
              caller,
              tripleStore,
              query,
              initialFetchExecutionContext(),
              {
                schema: options.schema,
                skipRules: options.skipRules,
                cache: options.cache,
                skipIndex: options.skipIndex,
                // TODO: do we need to pass state vector here?
              }
            );
            results = fetchResult.results;
            triples = fetchResult.triples;
            await onResults([
              new Map(
                [...results].map(([id, entity]) => [
                  id,
                  convertEntityToJS(
                    entity,
                    options.schema,
                    query.collectionName
                  ),
                ])
              ) as FetchResult<M, Q>,
              triples,
            ]);
            return;
          }

          const allInserts = Object.values(storeWrites).flatMap(
            (ops) => ops.inserts
          );
          const allDeletes = Object.values(storeWrites).flatMap(
            (ops) => ops.deletes
          );
          let nextResult = new Map(results);
          const matchedTriples: Map<string, TripleRow[]> = new Map();
          const updatedEntitiesForQuery = new Set<string>(
            [...allInserts, ...allDeletes]
              .map(({ id }) => splitIdParts(id))
              .filter(
                ([collectionName, _id]) =>
                  collectionName === query.collectionName
              )
              .map(([_collectionName, id]) => id)
          );
          // Early return prevents processing if no relevant entities were updated
          // While a query is always scoped to a single collection this is safe
          if (!updatedEntitiesForQuery.size) return;

          let queryShouldRefire = false;

          // Helpers for limit window
          const endOfWindow = [...nextResult.values()].at(-1);
          const windowSize = nextResult.size;

          for (const entity of updatedEntitiesForQuery) {
            const entityTriples = await genToArr(
              tripleStore.findByEntity(
                appendCollectionToId(query.collectionName, entity)
              )
            );

            function entityMatchesAfter(
              entity: any,
              query: CollectionQuery<any, any>
            ) {
              if (!query.after) return true;
              if (!query.order?.length) return true;
              const orderAttr = query.order[0][0];
              const orderDir = query.order[0][1];
              const [cursor, inclusive] = query.after;
              const [afterEntityValue, afterEntityId] = cursor;
              const entityValue = entity[orderAttr][0];
              // TODO: need to perform encoding at least I think...
              if (orderDir === 'ASC') {
                if (entityValue === afterEntityValue) {
                  return inclusive
                    ? entity.id[0] >= stripCollectionFromId(afterEntityId)
                    : entity.id[0] > stripCollectionFromId(afterEntityId);
                }
                return (
                  entityValue >
                  // @ts-expect-error - handle encoding / null / dates / etc
                  afterEntityValue
                );
              } else {
                if (entityValue === afterEntityValue) {
                  return inclusive
                    ? entity.id[0] <= stripCollectionFromId(afterEntityId)
                    : entity.id[0] < stripCollectionFromId(afterEntityId);
                }
                return (
                  entityValue <
                  // @ts-expect-error - handle encoding / null / dates / etc
                  afterEntityValue
                );
              }
            }

            const entityWrapper = new Entity();
            updateEntity(entityWrapper, entityTriples);
            const entityObj = entityWrapper.data;
            const isInCollection =
              entityObj['_collection'] &&
              entityObj['_collection'][0] === query.collectionName;
            const isInResult =
              isInCollection &&
              doesEntityObjMatchBasicWhere(
                entityObj,
                where ?? [],
                options.schema && options.schema[query.collectionName]?.schema
              ) &&
              entityMatchesAfter(entityObj, query);

            // Check if the result stays within the current range of the query based on the limit
            // If it doesnt, we'll remove and might add it back when we backfill
            let satisfiesLimitRange = true;
            if (order && limit && windowSize >= limit) {
              const sortFn = querySorter(query);
              satisfiesLimitRange = sortFn(entityObj, endOfWindow) < 1;
            }

            // Add to result or prune as needed
            if (isInResult && satisfiesLimitRange) {
              if (
                !nextResult.has(entity) ||
                !Equal(nextResult.get(entity), entityObj)
              ) {
                // Adding to result set
                nextResult.set(
                  entity,
                  entityObj as TimestampedFetchResultEntity<Q>
                );
                matchedTriples.set(
                  entity,
                  Object.values(entityWrapper.triples)
                );
                queryShouldRefire = true;
              }
            } else if (nextResult.has(entity)) {
              // prune from a result set
              nextResult.delete(entity);
              matchedTriples.set(entity, Object.values(entityWrapper.triples));
              queryShouldRefire = true;
            }
          }
          // No change to result, return early
          if (!queryShouldRefire) return;
          if (order || limit) {
            const entries = [...nextResult];

            // If we have removed data from the result set we need to backfill
            if (limit && entries.length < limit) {
              const lastResultEntry = entries.at(entries.length - 1);
              const lastResultEntryId =
                lastResultEntry &&
                appendCollectionToId(query.collectionName, lastResultEntry[0]);
              const backFillQuery = {
                ...query,
                limit: limit - entries.length,
                // If there is no explicit order, then order by Id is assumed
                after: lastResultEntryId
                  ? [
                      [
                        order
                          ? // @ts-expect-error TODO: eventually re-write this
                            lastResultEntry[1][order![0][0]][0]
                          : lastResultEntryId,
                        lastResultEntryId,
                      ],
                      false,
                    ]
                  : undefined,
              };
              const backFilledResults = await fetch<M, Q>(
                caller,
                tripleStore,
                backFillQuery,
                initialFetchExecutionContext(),
                {
                  schema: options.schema,
                  skipRules: options.skipRules,
                  // State vector needed in backfill?
                  cache: options.cache,
                  skipIndex: options.skipIndex,
                }
              );
              for (const entry of backFilledResults.results) {
                entries.push(entry);
              }
            }

            if (order) {
              // TODO: this fails...need loaded data...we dont have it from fetch...
              sortEntities(query, entries);
            }

            nextResult = new Map(entries.slice(0, limit));
          }

          results = nextResult as TimestampedFetchResult<Q>;
          triples = matchedTriples;
          // console.timeEnd('query recalculation');
          await onResults([
            new Map(
              [...results].map(([id, entity]) => [
                id,
                convertEntityToJS(entity, options.schema, query.collectionName),
              ])
            ) as FetchResult<M, Q>,
            triples,
          ]);
        } catch (e) {
          console.error(e);
          onError && (await onError(e));
        }
      });
      await onResults([
        new Map(
          [...results].map(([id, entity]) => [
            id,
            convertEntityToJS(entity, options.schema, query.collectionName),
          ])
        ) as FetchResult<M, Q>,
        triples,
      ]);
    } catch (e) {
      console.error(e);
      onError && (await onError(e));
    }
    return unsub;
  };

  const unsubPromise = asyncUnSub();

  return async () => {
    const unsub = await unsubPromise;
    unsub();
  };
}

export function subscribe<M extends Models, Q extends CollectionQuery<M, any>>(
  caller: DB<M>,
  tripleStore: TripleStore,
  query: Q,
  onResults: (results: FetchResult<M, Q>) => void | Promise<void>,
  onError?: (error: any) => void | Promise<void>,
  options: FetchFromStorageOptions = {}
) {
  return subscribeResultsAndTriples(
    caller,
    tripleStore,
    query,
    ([results]) => onResults(results),
    onError,
    options
  );
}

export function subscribeTriples<
  M extends Models,
  Q extends CollectionQuery<M, any>
>(
  caller: DB<M>,
  tripleStore: TripleStore,
  query: Q,
  onResults: (results: Map<string, TripleRow[]>) => void | Promise<void>,
  onError?: (error: any) => void | Promise<void>,
  options: FetchFromStorageOptions = {}
) {
  const asyncUnSub = async () => {
    let triples: Map<string, TripleRow[]> = new Map();
    try {
      if (options.stateVector && options.stateVector.size > 0) {
        const triplesAfterStateVector = await getTriplesAfterStateVector(
          tripleStore,
          options.stateVector
        );
        const deltaTriples = await fetchDeltaTriples(
          caller,
          tripleStore,
          query,
          triplesAfterStateVector,
          initialFetchExecutionContext(),
          options
        );
        triples = deltaTriples.reduce((acc, t) => {
          if (acc.has(t.id)) {
            acc.get(t.id)!.push(t);
          } else {
            acc.set(t.id, [t]);
          }
          return acc;
        }, new Map<string, TripleRow[]>());
      } else {
        const fetchResult = await fetch<M, Q>(
          caller,
          tripleStore,
          query,
          initialFetchExecutionContext(),
          {
            schema: options.schema,
            stateVector: options.stateVector,
            cache: options.cache,
          }
        );
        triples = fetchResult.triples;
      }

      const unsub = tripleStore.onWrite(async (storeWrites) => {
        const allInserts = Object.values(storeWrites).flatMap(
          (ops) => ops.inserts
        );
        const deltaTriples = await fetchDeltaTriples(
          caller,
          tripleStore,
          query,
          allInserts,
          initialFetchExecutionContext(),
          options
        );

        const triplesMap = deltaTriples.reduce((acc, t) => {
          if (acc.has(t.id)) {
            acc.get(t.id)!.push(t);
          } else {
            acc.set(t.id, [t]);
          }
          return acc;
        }, new Map<string, TripleRow[]>());

        if (triplesMap.size > 0) {
          onResults(triplesMap);
        }
      });
      await onResults(triples);
      return unsub;
    } catch (e) {
      console.error(e);
      onError && (await onError(e));
    }
    return () => {};
  };

  const unsubPromise = asyncUnSub();

  return async () => {
    const unsub = await unsubPromise;
    unsub();
  };
}

// Subquery variables should include attr: undefined if the entity does not have a value for a given attribute
// This is because the subquery may depend on that variable key existing
// This is worth refactoring, but for now this works
function extractSubqueryVarsFromEntity(
  entity: any,
  schema: Models | undefined,
  collectionName: string
) {
  let vars: any = {};
  if (schema) {
    const collectionSchema = schema[collectionName]?.schema;
    const emptyObj = Object.entries(collectionSchema.properties).reduce<any>(
      (v, [propName, typeDef]) => {
        if (typeDef.type === 'query') return v;
        v[propName] = undefined;
        return v;
      },
      {}
    );
    vars = {
      ...emptyObj,
      ...convertEntityToJS(entity, schema, collectionName),
    };
  } else {
    vars = { ...timestampedObjectToPlainObject(entity as any, true) };
  }
  vars['_collection'] = collectionName;
  // delete vars['_collection'];
  return vars;
}

function selectParser(entity: any) {
  return (acc: Record<string, any>, selectPath: any) => {
    const pathParts = (selectPath as string).split('.');
    const leafMostPart = pathParts.pop()!;
    let selectScope = acc;
    let entityScope = entity;
    for (const pathPart of pathParts) {
      selectScope[pathPart] = selectScope[pathPart] ?? {};
      selectScope = selectScope[pathPart];
      entityScope = entity[pathPart][0];
    }
    selectScope[leafMostPart] = entityScope[leafMostPart];

    return acc;
  };
}

async function replaceVariablesInQuery<Q extends CollectionQuery<any>>(
  caller: DB<any>,
  tx: TripleStoreApi,
  query: Q,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions
): Promise<Q> {
  // Check that where clause statements have variables loaded
  // Performance: we may load this earlier than needed if it could be filtered out by another statement
  const clauses = (query.where ?? []).filter(isFilterStatement);

  for (const clause of clauses) {
    const [prop, op, val] = clause;
    if (isValueVariable(val)) {
      await loadRelationshipsIntoContextFromVariable(
        val,
        caller,
        tx,
        executionContext,
        options
      );
    }
  }

  const vars = getQueryVariables(
    query,
    { systemVars: caller.systemVars, roles: caller.sessionRoles },
    executionContext
  );

  const where = query.where
    ? replaceVariablesInFilterStatements(query.where, vars)
    : undefined;

  // TODO: might be variables in select too

  return { ...query, where } as Q;
}

export function getQueryVariables<
  M extends Models,
  CN extends CollectionNameFromModels<M>,
  Q extends Partial<Pick<CollectionQuery<M, CN>, 'collectionName' | 'vars'>>
>(
  query: Q,
  session: {
    systemVars?: SystemVariables;
    roles?: SessionRole[];
  },
  executionContext: FetchExecutionContext
) {
  // For backwards compatability we are including non-scoped variables, these values may conflict and cause issues
  const conflictingVariables = {
    ...(session.systemVars?.global ?? {}),
    ...(session.systemVars?.session ?? {}),
    ...(query.vars ?? {}),
    ...(executionContext?.queriedDataStack ?? []).reduce((acc, val) => {
      return { ...acc, ...val };
    }, {}),
  };
  // Prefix variables with their scopes to prevent conflicts
  const scopedVariables = {
    global: session.systemVars?.global ?? {},
    session: session.systemVars?.session ?? {},
    query: query.vars ?? {},
    role:
      // Small hack to prevent role variables from being accessed when loading schema initially
      // TODO: Address when refactoring schema storage / loading
      query.collectionName === '_metadata'
        ? undefined
        : session.roles?.reduce((acc, val) => {
            return { ...acc, ...val.roleVars };
          }, {}),
    ...(executionContext?.queriedDataStack ?? []).reduce((acc, val, i, arr) => {
      return { ...acc, [arr.length - i]: val };
    }, {}),
  };
  return {
    ...conflictingVariables,
    ...scopedVariables,
  };
}

// TODO: refactor this to support nested relationships (would be a helpful time to implement a normalized cache during querying, in executionContext)
async function loadRelationshipsIntoContextFromVariable<M extends Models>(
  variable: string,
  caller: DB<M>,
  tx: TripleStoreApi,
  executionContext: FetchExecutionContext,
  options: FetchFromStorageOptions
) {
  if (!options.schema) return;
  const [scope, key] = getVariableComponents(variable);
  const parsedScope = parseInt(scope ?? '');
  if (!isNaN(parsedScope)) {
    const stackLocation =
      executionContext.queriedDataStack.length - parsedScope;
    const referenceEntity = executionContext.queriedDataStack[stackLocation];
    // If path is subquery, need to load that data
    const relations = getRelationsFromIdentifier(
      key,
      options.schema,
      referenceEntity._collection
    );
    const relationEntries = Object.entries(relations);
    if (relationEntries.length > 0) {
      // Load the data from the relation path
      const rootRelation = relationEntries.at(0)!;
      const deepestRelation = relationEntries.at(-1)!;
      const pathToLoad = deepestRelation[0];
      const rootRelationQueryType = rootRelation[1];
      const pathParts = pathToLoad.split('.');
      if (rootRelationQueryType.cardinality !== 'one')
        throw new TriplitError('Cannot load variables with cardinality "many"');

      const includeStatement = pathParts
        .slice(1)
        .reverse()
        .reduce<any>((include, key) => {
          return {
            [key]: include,
          };
        }, null);
      let subquery = { ...rootRelationQueryType.query };
      if (includeStatement !== null) {
        subquery.include = includeStatement;
      }

      const { results: subqueryResult } = await loadSubquery(
        caller,
        tx,
        { collectionName: referenceEntity._collection },
        subquery,
        rootRelationQueryType.cardinality,
        initialFetchExecutionContext(),
        options,
        referenceEntity
      );
      referenceEntity[pathParts[0]] = timestampedObjectToPlainObject(
        subqueryResult as any
      );
    }
  }
}

// Used for entity reducer
export type TimestampedTypeFromModel<M extends Model> =
  ExtractTimestampedType<M>;

export function convertEntityToJS<
  M extends Models,
  CN extends CollectionNameFromModels<M>
>(
  entity: TimestampedTypeFromModel<ModelFromModels<M, CN>>,
  schema?: M,
  collectionName?: CN
) {
  // remove timestamps
  const untimestampedEntity = timestampedObjectToPlainObject(entity);
  // Clean internal fields from entities
  delete untimestampedEntity._collection;

  // @ts-expect-error - weird types here
  const collectionSchema = schema?.[collectionName]?.schema;

  // convert values based on schema
  return collectionSchema
    ? collectionSchema.convertDBValueToJS(untimestampedEntity, schema)
    : untimestampedEntity;
}

export function isQueryInclusionSubquery<M extends Models>(
  inclusion: QueryInclusion<M, any>
): inclusion is RelationSubquery<M, any, any> {
  return (
    !isQueryInclusionShorthand(inclusion) &&
    typeof inclusion === 'object' &&
    'subquery' in inclusion
  );
}

export function isQueryInclusionShorthand<M extends Models>(
  inclusion: QueryInclusion<M, any>
): inclusion is true | null {
  return inclusion === true || inclusion === null;
}

export function isQueryInclusionReference<M extends Models>(
  inclusion: QueryInclusion<M>
): inclusion is RefSubquery<M> {
  return (
    !isQueryInclusionShorthand(inclusion) &&
    typeof inclusion === 'object' &&
    '_rel' in inclusion
  );
}
