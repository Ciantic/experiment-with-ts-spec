/**
 * The hand-written half of the API: one HTTP request in, one generated call out.
 * See docs/rest-api.md.
 *
 * The router owns parsing, validation, and status mapping; the generated
 * `routes.ts` owns which calls exist. The body codec is `devalue`, so a request
 * and a response carry real `Date` and `bigint` values and need no wire schema.
 */
import { parse as decode, stringify as encode } from "devalue";
import type { SqlExecutor } from "../db/sql-executor.ts";

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** The part of a schema the router uses. Structural, so the router couples to no Zod version. */
export interface RouteInput {
    safeParse(
        value: unknown,
    ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
}

/** One exposed call. `routes.ts` is generated against this shape. */
export interface Route {
    method: HttpMethod;
    path: string;
    /**
     * Where the call carries its argument. `query` reads the `q` parameter; `body`
     * reads the request body. The generated table decides, not the router.
     */
    source: "query" | "body";
    /** Validates the decoded argument. */
    input: RouteInput;
    handler: (db: SqlExecutor, argument: unknown) => Promise<unknown>;
}

/** One request, with the body already read into a string. */
export interface HttpRequest {
    method: string;
    /** The path and query string, e.g. `/invoice/query?q=…`. */
    url: string;
    body: string;
}

/** One response. Success bodies are `devalue`; error bodies are plain JSON. */
export interface HttpResponse {
    status: number;
    body: string;
}

/** PostgreSQL error codes to HTTP statuses. Anything else is a server fault. */
const ERROR_STATUSES: Record<string, number> = {
    "22P02": 400, // invalid_text_representation
    "23502": 400, // not_null_violation
    "23503": 409, // foreign_key_violation
    "23505": 409, // unique_violation
    "40001": 409, // serialization_failure: the version-conflict raise. See docs/versioning.md
};

/** The status a thrown database error maps to. */
function statusFor(thrown: unknown): number {
    const code = (thrown as { code?: unknown }).code;
    if (typeof code !== "string") {
        return 500;
    }
    return ERROR_STATUSES[code] ?? 500;
}

/** A plain-JSON error body, so a failure is readable without the codec. */
function error(status: number, message: string): HttpResponse {
    return { status, body: JSON.stringify({ error: message }) };
}

/** A router over a route table, reusing one `db` for every call. */
export function createRouter(db: SqlExecutor, routes: Route[]) {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));

    return {
        /** Match, decode, validate, call, and encode one request. Never throws. */
        async handle(request: HttpRequest): Promise<HttpResponse> {
            const url = new URL(request.url, "http://localhost");
            const route = byKey.get(`${request.method} ${url.pathname}`);
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
                // A `get` miss and a void write both encode as `null`.
                return { status: 200, body: encode((await route.handler(db, parsed.data)) ?? null) };
            } catch (thrown) {
                const message = thrown instanceof Error ? thrown.message : "request failed";
                return error(statusFor(thrown), message);
            }
        },
    };
}
