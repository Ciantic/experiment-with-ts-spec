/**
 * The hand-written half of the API: one HTTP request in, one generated call out.
 * See docs/rest-api-effect.md.
 *
 * The router owns parsing, validation, and status mapping; the generated
 * `routes.ts` owns which calls exist. The body codec is `devalue`, so a request
 * and a response carry real `Date` and `bigint` values and need no wire schema.
 * It returns an `HttpServerResponse` — never a failure — and requires only the
 * `SqlClient` the generated handler needs, since `effect/http` supplies the
 * request for each call.
 */
import { Effect, Schema } from "effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import { SqlClient } from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import { parse as decode, stringify as encode } from "devalue";

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One exposed call. `routes.ts` is generated against this shape. */
export interface Route {
    method: HttpMethod;
    path: string;
    /**
     * Where the call carries its argument. `query` reads the `q` parameter; `body`
     * reads the request body. The generated table decides, not the router.
     */
    source: "query" | "body";
    /** Validates the decoded argument. Decoded with `onExcessProperty: "error"`, so an unknown key fails. */
    input: Schema.ConstraintDecoder<unknown>;
    handler: (argument: unknown) => Effect.Effect<unknown, SqlError, SqlClient>;
}

/** `effect/sql` error reasons to HTTP statuses. Anything else is a server fault. */
const ERROR_STATUSES: Record<string, number> = {
    SqlSyntaxError: 400,
    ConstraintError: 409,
    UniqueViolation: 409,
    SerializationError: 409,
    DeadlockError: 409,
    LockTimeoutError: 409,
    StatementTimeoutError: 408,
};

/** The status a thrown `SqlError` maps to, read from its classified reason. */
function statusFor(thrown: unknown): number {
    const reason = (thrown as { reason?: { _tag?: unknown } }).reason;
    const tag = reason?._tag;
    return typeof tag === "string" ? (ERROR_STATUSES[tag] ?? 500) : 500;
}

/** A plain-JSON response, so a success body stays `devalue` but an error is readable without the codec. */
function respond(status: number, body: string): HttpServerResponse.HttpServerResponse {
    return HttpServerResponse.text(body, { status, contentType: "application/json" });
}

/** A plain-JSON error body. */
function error(status: number, message: string): HttpServerResponse.HttpServerResponse {
    return respond(status, JSON.stringify({ error: message }));
}

/** A router over a route table, handling one request as an `HttpServerResponse`. */
export function createRouter(
    routes: Route[],
): Effect.Effect<HttpServerResponse.HttpServerResponse, never, HttpServerRequest | SqlClient> {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));

    return Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const route = byKey.get(`${request.method} ${url.pathname}`);
        if (!route) {
            return error(404, "no route");
        }

        // A read body is empty; a failed read is treated as empty rather than a 500.
        const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
        // A `query` call carries its argument in `q`; a `body` call in the request body.
        const encoded =
            route.source === "query"
                ? (url.searchParams.get("q") ?? undefined)
                : body === ""
                    ? undefined
                    : body;

        let value: unknown;
        if (encoded !== undefined) {
            try {
                value = decode(encoded);
            } catch {
                return error(400, "malformed request");
            }
        }

        const parsed = Schema.decodeUnknownResult(route.input, { onExcessProperty: "error" })(value);
        if (parsed._tag === "Failure") {
            return respond(400, JSON.stringify({ error: "invalid request", issues: parsed.failure }));
        }

        const result = yield* Effect.result(route.handler(parsed.success));
        if (result._tag === "Failure") {
            return error(statusFor(result.failure), result.failure.message);
        }
        // A `get` miss and a void write both encode as `null`.
        return respond(200, encode(result.success ?? null));
    });
}
