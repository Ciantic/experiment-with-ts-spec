/**
 * A `node:http` server over the Hono app. See docs/rest-api.md.
 *
 * Deliberately thin: Hono matches a request and `app.ts` handles it, so this file
 * only binds the app's `fetch` to a listener.
 */
import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { createApiApp } from "./app.ts";

/** A server exposing the generated route table over `db`. */
export function createApiServer(db: SqlExecutor): Server {
    return createServer(getRequestListener(createApiApp(db).fetch));
}
