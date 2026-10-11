/** The hand-written request handler: match one request to its route, decode, check, run, and encode. See docs/rest-api.md. */
import { parse as decode, stringify as encode } from "devalue";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { GROUP_PATH, handleGroup } from "./group-handler.ts";
import { error, statusFor, type HttpResponse } from "./http-response.ts";

export type { HttpResponse };

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The part of a schema the router uses, structurally, so the router couples to no Zod version. */
export interface RouteInput {
    safeParse(
        value: unknown,
    ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
}

/** One exposed call. `routes.ts` is generated against this shape. */
export interface Route {
    method: HttpMethod;
    path: string;
    /** Whether the call carries its argument in `q` or in the request body. */
    source: "query" | "body";
    /** Validates the decoded argument. */
    input: RouteInput;
    /** Runs the call; it receives the request's `SqlExecutor` and may open a boundary. See docs/transactions.md. */
    handler: (db: SqlExecutor, argument: unknown) => Promise<unknown>;
}

/** One request, with the body already read into a string. */
export interface HttpRequest {
    method: string;
    /** The path and query string, e.g. `/invoice/query?q=…`. */
    url: string;
    body: string;
}

/** A router over a route table, reusing one `db` for every call. */
export function createRouter(db: SqlExecutor, routes: Route[]) {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
    /** Resolve a single request and a group entry the same way, so the two cannot disagree. */
    const resolve = (method: string, path: string) => byKey.get(`${method} ${path}`);

    return {
        /** Match, decode, validate, call, and encode one request. Never throws. */
        async handle(request: HttpRequest): Promise<HttpResponse> {
            const url = new URL(request.url, "http://localhost");
            if (request.method === "POST" && url.pathname === GROUP_PATH) {
                return await handleGroup(db, resolve, request.body);
            }

            const route = resolve(request.method, url.pathname);
            if (!route) {
                return error(404, "no route");
            }

            // A `query` call carries its argument in `q`; a `body` call in the request body.
            const encoded =
                route.source === "query"
                    ? (url.searchParams.get("q") ?? undefined)
                    : request.body === ""
                        ? undefined
                        : request.body;

            let value: unknown;
            try {
                value = encoded === undefined ? undefined : decode(encoded);
            } catch {
                return error(400, "malformed request");
            }

            const parsed = route.input.safeParse(value);
            if (!parsed.success) {
                return {
                    status: 400,
                    body: JSON.stringify({ error: "invalid request", issues: parsed.error.issues }),
                };
            }

            try {
                const result = await route.handler(db, parsed.data);
                // A `get` miss and a void write both encode as `null`.
                return { status: 200, body: encode(result ?? null) };
            } catch (thrown) {
                const message = thrown instanceof Error ? thrown.message : "request failed";
                return error(statusFor(thrown), message);
            }
        },
    };
}
