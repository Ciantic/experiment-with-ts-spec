/** The hand-written request handler: match one request to its route, read, decode, check, run, and encode. See docs/rest-api.md. */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { parse as decode, stringify as encode } from "devalue";
import { NotFoundError, PayloadTooLargeError, RequestError, ValidationError } from "sdk/errors.ts";
import { createRequestContext, type AppContext, type RequestContext } from "../context.ts";
import { GROUP_PATH, handleGroup } from "./group-handler.ts";
import { errorFrom, type HttpResponse } from "./http-response.ts";

export type { HttpResponse };

/** The largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Read a request body, refusing one larger than {@link MAX_BODY_BYTES}.
 * @throws {PayloadTooLargeError} when the body passes the byte cap
 */
async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            throw new PayloadTooLargeError("request body too large");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** The part of a schema the router uses, structurally, so the router couples to no Zod version. */
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
    /** Runs the call; it receives the request's context and may open a boundary on it. See docs/transactions.md. */
    handler: (ctx: RequestContext, argument: unknown) => Promise<unknown>;
}

/** A router over a route table, building one request context per call over the app's shared pool. */
export function createRouter(app: AppContext, routes: Route[]) {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
    const byId = new Map(routes.map((route) => [route.id, route]));
    /** Resolve a single request and a group entry out of one table, so the two cannot disagree. */
    const resolve = (method: string, path: string) => byKey.get(`${method} ${path}`);

    return {
        /** Match, read, decode, validate, call, and encode one request. Never throws. */
        async handle(request: IncomingMessage): Promise<HttpResponse> {
            const url = new URL(request.url ?? "/", "http://localhost");
            // A missing method is read as `GET`, the method a request without one carries.
            const method = request.method ?? "GET";
            // One context per request, so a route never reaches for a dependency the router did not hand it.
            const context = await createRequestContext(app, request);

            let body: string;
            try {
                body = await readBody(request);
            } catch (thrown) {
                return errorFrom(thrown);
            }

            if (method === "POST" && url.pathname === GROUP_PATH) {
                // A group entry names an operation rather than a verb and a path, so it resolves by id.
                return await handleGroup(context.db, (id) => byId.get(id), body);
            }

            const route = resolve(method, url.pathname);
            if (!route) {
                return errorFrom(new NotFoundError("no route"));
            }

            // A `query` call carries its argument in `q`; a `body` call in the request body.
            const encoded =
                route.source === "query" ? (url.searchParams.get("q") ?? undefined) : body === "" ? undefined : body;

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
