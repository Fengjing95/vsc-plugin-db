import type { CompletionSource } from '@db-explorer/core';

/**
 * mongosh 命令域全量词表（C-14 / 驱动规范 §3.2 @since v0.1.6：supportsSQL=false 命令域，
 * 先例 driver-redis）。纯数据模块，勿散落 index.ts。首批只读（D-17）：写方法保留在词表
 * （补全可见），执行被命令白名单 + 驱动 E_UNSUPPORTED 双重拦截。
 */

export const MONGO_KEYWORDS: readonly string[] = [
  // shell 帮助与语句
  'db', 'use', 'show', 'it', 'exit', 'quit', 'help', 'version',
  // db 级方法
  'getCollection', 'getCollectionNames', 'getCollectionInfos', 'getDB', 'getDBNames', 'getSiblingDB',
  'runCommand', 'stats', 'dbStats', 'getName', 'getMongo', 'listCommands',
  // collection 级方法（读）
  'find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'distinct',
  'getIndexes', 'getIndexSpecs', 'isCapped', 'exists', 'explain', 'validate', 'getFullName',
  // collection 级方法（写/管理——可见不可执行，首批只读拦截）
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'bulkWrite', 'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'findAndModify',
  'drop', 'dropDatabase', 'createCollection', 'renameCollection', 'createIndex', 'dropIndex', 'dropIndexes',
  // 游标方法（链式首批不支持，词表保留供认知）
  'toArray', 'forEach', 'limit', 'skip', 'sort', 'size', 'count', 'pretty', 'hint', 'batchSize', 'itcount',
  // 构造器/类型包装
  'ObjectId', 'ISODate', 'Date', 'NumberLong', 'NumberInt', 'NumberDecimal', 'BinData', 'UUID', 'Code', 'Timestamp',
  'true', 'false', 'null',
];

export const MONGO_FUNCTIONS: readonly string[] = [
  // 聚合管道阶段
  '$match', '$project', '$addFields', '$set', '$unset', '$replaceRoot', '$replaceWith', '$group',
  '$sort', '$limit', '$skip', '$unwind', '$lookup', '$graphLookup', '$sample', '$facet', '$bucket',
  '$unionWith', '$out', '$merge', '$count', '$sortByCount', '$documents',
  // 聚合累加器/运算符
  '$sum', '$avg', '$min', '$max', '$first', '$last', '$push', '$addToSet', '$stdDevPop', '$stdDevSamp',
  '$cond', '$ifNull', '$switch', '$concat', '$substr', '$toUpper', '$toLower', '$split', '$strLen', '$trim',
  '$size', '$arrayElemAt', '$filter', '$map', '$reduce', '$objectToArray', '$setUnion', '$setIntersection',
  // 查询/投影操作符
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin', '$and', '$or', '$not', '$nor', '$exists',
  '$regex', '$elemMatch', '$all', '$type', '$mod', '$expr',
  // 类型转换/日期
  '$toInt', '$toLong', '$toDouble', '$toString', '$toDate', '$toBool', '$convert', '$dateToString',
  '$dateAdd', '$dateDiff',
];

export const MONGO_COMPLETION_SNIPPETS: ReadonlyArray<{ label: string; body: string; description?: string }> = [
  { label: 'find 全量 (模板)', body: 'db.${1:collection}.find({})', description: '查询 collection（首批只读）' },
  {
    label: 'find 条件 (模板)',
    body: 'db.${1:collection}.find({ ${2:field}: ${3:value} })',
    description: '条件查询',
  },
  {
    label: 'find 排序截取 (模板)',
    body: 'db.${1:collection}.find({}, { sort: { ${2:_id}: -1 }, limit: ${3:50} })',
    description: '排序 + 截取（find 第二参 options）',
  },
  {
    label: 'aggregate 分组统计 (模板)',
    body: 'db.${1:collection}.aggregate([ { $group: { _id: "$${2:field}", n: { $sum: 1 } } }, { $sort: { n: -1 } } ])',
    description: '按字段分组计数',
  },
  {
    label: 'aggregate 匹配计数 (模板)',
    body: 'db.${1:collection}.aggregate([ { $match: { ${2:field}: ${3:value} } }, { $count: "n" } ])',
    description: '过滤后计数',
  },
  {
    label: 'countDocuments (模板)',
    body: 'db.${1:collection}.countDocuments({ ${2:field}: ${3:value} })',
    description: '精确计数',
  },
  { label: 'distinct (模板)', body: 'db.${1:collection}.distinct("${2:field}")', description: '字段去重取值' },
  {
    label: 'getCollection (模板)',
    body: "db.getCollection('${1:collection}').find({})",
    description: 'collection 名含特殊字符/点号时用',
  },
  { label: 'show dbs', body: 'show dbs', description: '库列表（系统库已过滤）' },
  { label: 'show collections', body: 'show collections', description: '当前库 collection 列表' },
  { label: 'use 库 (模板)', body: 'use ${1:database}', description: '切换 Console 绑定库（不下发服务端）' },
  { label: 'runCommand ping', body: 'db.runCommand({ ping: 1 })', description: '连通性探针' },
];

/** CompletionSource 组装（词表 + 库列表；命令控制台不提供表/列元数据，与 redis 同口径） */
export function mongoCompletionSource(databases: string[]): CompletionSource {
  return {
    keywords: [...MONGO_KEYWORDS],
    functions: [...MONGO_FUNCTIONS],
    databases,
    tables: [],
    columns: [],
    snippets: MONGO_COMPLETION_SNIPPETS.map((s) => ({ ...s })),
  };
}
