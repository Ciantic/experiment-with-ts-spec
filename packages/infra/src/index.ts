/** The infra package entry: the database, request plumbing, and HTTP runtime the backend builds on. */
export { createAppContext, createRequestContext } from "./context.ts";
export type { AppContext, AppOptions, RequestContext, ServerDatabase } from "./context.ts";

export { MockDataError, UsageError } from "./errors.ts";

export { attempt, attemptWith, batch, transaction, transactionWith } from "./db/group.ts";
export type { Attempted, Step } from "./db/group.ts";
export { DEFAULT_LIMIT, createResolver } from "./db/resolvers.ts";
export type {
    FilterDefault,
    InlinedRelation,
    OrderClause,
    QueryModel,
    QueryRelation,
    QueryTable,
    ResolveOptions,
    Resolver,
    TableRelation,
    WhereClause,
} from "./db/resolvers.ts";
export {
    ACCESS_MODES,
    ISOLATION_LEVELS,
    MAX_STATEMENT_PARAMETERS,
    affectedRows,
    createTransactionalDb,
    resultRows,
} from "./db/sql-executor.ts";
export type { SqlExecutor, TransactionOptions } from "./db/sql-executor.ts";
export { createSingleConnectionPool } from "./db/sql-pool.ts";
export type { SqlPool, SqlSession } from "./db/sql-pool.ts";

export * from "./db/queries/index.ts";
export * from "./db/repositories/index.ts";

export { errorFrom, statusFor } from "./http/http-response.ts";
export type { HttpResponse } from "./http/http-response.ts";
export { GROUP_PATH, handleGroup } from "./http/group-handler.ts";
export type { ResolveRoute } from "./http/group-handler.ts";
export { createRouter } from "./http/router.ts";
export type { HttpMethod, Route, RouteInput } from "./http/router.ts";
export { createApiServer } from "./http/server.ts";
export { entityRoutes } from "./http/routes/index.ts";

export { seedMockData } from "./mock/seed.ts";

export { createPgMapperTypes, createPgPool } from "./postgres/pg-setup.ts";
export type { PgMapperOptions, PgModule, PgPoolModule } from "./postgres/pg-setup.ts";
export { createPglite, createPgliteParsers, createPglitePool } from "./postgres/pglite-setup.ts";
