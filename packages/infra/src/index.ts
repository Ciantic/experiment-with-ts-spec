/** The infra package entry: the hand-written surface the backend imports, plus the generated data access. */

// Context exports
export { createAppContext, RequestContext } from "./context.ts";
export type { AppContext, AppOptions } from "./context.ts";

// Schema exports
export { applySchema } from "./postgres/schema.ts";

// Driver exports
export { PgliteSqlDriver } from "./postgres/pglite-setup.ts";
export type { PgliteConstructor, PgliteDriverOptions } from "./postgres/pglite-setup.ts";
export { PgSqlDriver } from "./postgres/pg-setup.ts";
export type { PgMapperOptions } from "./postgres/pg-setup.ts";
export { SqlDriver } from "./db/sql-driver.ts";
export type { SqlConnection } from "./db/sql-driver.ts";

// Error exports
export { NotificationsUnsupportedError } from "./errors.ts";

// Database exports
export { ACCESS_MODES, ISOLATION_LEVELS } from "./db/sql-executor.ts";
export type { QueryResult, SqlExecutor, SqlSubscription, TransactionOptions } from "./db/sql-executor.ts";
export { subscribe } from "./db/notifications.ts";
export type { ChangeNotification } from "./db/notifications.ts";

// Router exports
export { entityRoutes } from "./http/routes/index.ts";
export { ApiRouter, defineRoute } from "./http/router.ts";
export type { HttpRouter, Route } from "./http/router.ts";
export { ApiServer } from "./http/server.ts";
export type { HttpServer } from "./http/server.ts";
export { ApiHttpResponse, WritableResponse } from "./http/api-http-response.ts";
export { SseStream } from "./http/sse.ts";

// Mock data exports
export { seedMockData } from "./mock/seed.ts";

// Query and repository exports
export * from "./db/queries/index.ts";
export * from "./db/repositories/index.ts";
