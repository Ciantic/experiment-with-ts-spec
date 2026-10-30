/** The infra package entry: the hand-written surface the backend imports, plus the generated data access. */

// Context exports
export { createAppContext } from "./context.ts";
export type { AppContext, AppOptions, RequestContext } from "./context.ts";

// Driver exports
export { PgliteSqlDriver } from "./postgres/pglite-setup.ts";
export type { PgliteConstructor } from "./postgres/pglite-setup.ts";
export { PgSqlDriver } from "./postgres/pg-setup.ts";
export { SqlDriver } from "./db/sql-driver.ts";
export type { SqlConnection } from "./db/sql-driver.ts";

// Error exports
export { UsageError } from "./errors.ts";

// Database exports
export type { SqlExecutor } from "./db/sql-executor.ts";

// Router exports
export { entityRoutes } from "./http/routes/index.ts";
export { createApiServer } from "./http/server.ts";
export type { Route } from "./http/router.ts";

// Mock data exports
export { seedMockData } from "./mock/seed.ts";

// Query and repository exports
export * from "./db/queries/index.ts";
export * from "./db/repositories/index.ts";
