/** The infra package entry: the hand-written surface the backend imports, plus the generated data access. */

// Context exports
export { createAppContext } from "./context.ts";
export type { AppOptions, ServerDatabase } from "./context.ts";

// Error exports
export { UsageError } from "./errors.ts";

// Database exports
export { resultRows } from "./db/sql-executor.ts";
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
