/** The backend context a process creates once, and the context each request builds over it. See docs/operations.md. */
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { SqlExecutor } from "./db/sql-executor.ts";
import type { SqlDriver } from "./db/sql-driver.ts";

/** The generated DDL, next to the driver setup. */
const SCHEMA_URL = new URL("./postgres/schema.sql", import.meta.url);

/** How to build the app context. */
export interface AppOptions {
    /** The driver the process chose for its database. */
    driver: SqlDriver;
    /** Apply the generated DDL at startup; on by default. */
    applySchema?: boolean;
}

/** What startup creates once: the driver requests derive their executor from, and the process closes. */
export interface AppContext {
    /** The process's driver: each request builds its executor over it, and its owner closes it. */
    driver: SqlDriver;
}

/** What a route handler receives: the backend's context for one request. */
export interface RequestContext {
    /** The executor the call runs on; a group hands the boundary its kind opened. */
    db: SqlExecutor;
}

/** Build the process's context over the driver it was given, applying the generated DDL first. */
export async function createAppContext(options: AppOptions): Promise<AppContext> {
    const { driver, applySchema = true } = options;
    if (applySchema) {
        await driver.exec(readFileSync(SCHEMA_URL, "utf8"));
    }
    return { driver };
}

/** Build one request's context over the app's driver, so a request gets its own executor rather than the process's. */
export async function createRequestContext(app: AppContext, _request: IncomingMessage): Promise<RequestContext> {
    return { db: app.driver.createExecutor() };
}
