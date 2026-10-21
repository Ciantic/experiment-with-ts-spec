/** The hand-written request handler: match one request to its route, decode, check, run, and encode. See docs/rest-api.md. */
import { parse as decode, stringify as encode } from "devalue";
import { NotFoundError, RequestError, ValidationError } from "sdk/errors.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { GROUP_PATH, handleGroup } from "./group-handler.ts";
import { errorFrom, type HttpResponse } from "./http-response.ts";

export type { HttpResponse };

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The part of a schema the router uses, structurally, so the router couples to no Zod version. */
export interface RouteInput {
    safeParse(
        value: unknown,
    ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
}

/** What a route handler receives: the backend's context for one request. See docs/operations.md. */
export interface RouteContext {
    /** The executor the call runs on; a group hands the boundary its kind opened. */
    db: SqlExecutor;
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
    /** Runs the call; it receives the request's context and may open a boundary on it. See docs/transactions.md. */
    handler: (ctx: RouteContext, argument: unknown) => Promise<unknown>;
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
    // One context per server, so a route never reaches for a dependency the router did not hand it.
    const context: RouteContext = { db };
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
    const byId = new Map(routes.map((route) => [route.id, route]));
    /** Resolve a single request and a group entry out of one table, so the two cannot disagree. */
    const resolve = (method: string, path: string) => byKey.get(`${method} ${path}`);

    return {
        /** Match, decode, validate, call, and encode one request. Never throws. */
        async handle(request: HttpRequest): Promise<HttpResponse> {
            const url = new URL(request.url, "http://localhost");
            if (request.method === "POST" && url.pathname === GROUP_PATH) {
                // A group entry names an operation rather than a verb and a path, so it resolves by id.
                return await handleGroup(db, (id) => byId.get(id), request.body);
            }

            const route = resolve(request.method, url.pathname);
            if (!route) {
                return errorFrom(new NotFoundError("no route"));
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
                return errorFrom(new RequestError("malformed request"));
            }

            const parsed = route.input.safeParse(value);
            if (!parsed.success) {
                return errorFrom(new ValidationError("invalid request", { issues: parsed.error.issues }));
            }

            try {
                const result = await route.handler(context, parsed.data);
                // A `get` miss and a void write both encode as `null`.
                return { status: 200, body: encode(result ?? null) };
            } catch (thrown) {
                return errorFrom(thrown);
            }
        },
    };
}
