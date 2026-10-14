/**
 * The shape of one exposed call. `routes/` is generated against it, the Hono app
 * registers it on its verb and path, and the group handler resolves it by id.
 * See docs/rest-api.md.
 */
import type { SqlExecutor } from "../db/sql-executor.ts";

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The part of a schema the app uses, structurally, so it couples to no Zod version. */
export interface RouteInput {
    safeParse(
        value: unknown,
    ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
}

/** One exposed call: an HTTP route a single request matches, and an id a group entry names. */
export interface Route {
    /** The operation's name, e.g. `queryInvoice`. The generated builder and a group entry both use it. */
    id: string;
    method: HttpMethod;
    path: string;
    /** Whether the call carries its argument in `q` or in the request body. */
    source: "query" | "body";
    /** Validates the decoded argument. */
    input: RouteInput;
    /** Runs the call; it receives the request's `SqlExecutor` and may open a boundary. See docs/transactions.md. */
    handler: (db: SqlExecutor, argument: unknown) => Promise<unknown>;
}
