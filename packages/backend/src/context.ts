/** The backend context a process creates once, and the context each request builds over it. See docs/operations.md. */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { createTransactionalDb, type SqlExecutor } from "./db/sql-executor.ts";
import type { SqlPool } from "./db/sql-pool.ts";
import { createPglite, createPglitePool } from "./postgres/pglite-setup.ts";

/** The generated DDL, next to the driver setup. */
const SCHEMA_URL = new URL("./postgres/schema.sql", import.meta.url);

/** The database a server runs on: the executor, plus the lifecycle its owner closes. */
export interface ServerDatabase extends SqlExecutor {
    close(): Promise<void>;
}

/** How to build the app context. */
export interface AppOptions {
    /** Let PGlite print every statement it runs, the transaction boundaries it issues included. */
    logSql?: boolean;
}

/** What startup creates once: the pool requests share, and the database seeding and shutdown use. */
export interface AppContext {
    /** The one pool over the process's in-memory database. */
    pool: SqlPool;
    /** The process's own handle, for startup work and for closing the driver. */
    database: ServerDatabase;
}

/** What a route handler receives: the backend's context for one request. */
export interface RequestContext {
    /** The executor the call runs on; a group hands the boundary its kind opened. */
    db: SqlExecutor;
}

/** Build the process's context: one PGlite instance with the generated schema applied, kept for the process's life. */
export async function createAppContext(options: AppOptions = {}): Promise<AppContext> {
    const driver = createPglite(options.logSql ? { debug: 1 } : {});
    await driver.exec(readFileSync(SCHEMA_URL, "utf8"));
    const pool = createPglitePool(driver);
    const db = createTransactionalDb(pool);
    const database: ServerDatabase = {
        query: (sql, parameters) => db.query(sql, parameters),
        transaction: (run) => db.transaction(run),
        transactionWith: (options, run) => db.transactionWith(options, run),
        close: () => driver.close(),
    };
    return { pool, database };
}

/** Build one request's context over the app's pool, so a request gets its own executor rather than the process's. */
export async function createRequestContext(app: AppContext, _request: IncomingMessage): Promise<RequestContext> {
    return { db: createTransactionalDb(app.pool) };
}
