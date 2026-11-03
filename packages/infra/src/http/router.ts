/** The hand-written request handler: match one request to its route, read, decode, check, and run it. See docs/rest-api.md. */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { parse as decode } from "devalue";
import { NotFoundError, PayloadTooLargeError, RequestError, ValidationError } from "sdk/errors.ts";
import { type AppContext, RequestContext } from "../context.ts";
import { GROUP_PATH, handleGroup } from "./group-handler.ts";

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
export interface RouteInput<T = unknown> {
    safeParse(
        value: unknown,
    ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

/** A check a route runs after its argument validates and before its handler; throwing refuses the call. */
export type RouteGuard<T = unknown> = (ctx: RequestContext, argument: T) => void | Promise<void>;

/** One exposed call: an HTTP route a single request matches, and an id a group entry names. */
export interface Route<T = unknown> {
    /** The operation's name, e.g. `queryInvoice`. The generated builder and a group entry both use it. */
    id: string;
    method: HttpMethod;
    path: string;
    /** Whether the call carries its argument in `q` or in the request body. */
    source: "query" | "body";
    /** True when the handler answers with a long-lived event stream a group cannot run. See docs/notifications.md. */
    stream?: boolean;
    /** Validates the decoded argument. */
    input: RouteInput<T>;
    /** Refuses the call by throwing; absent when the route needs no check. */
    guard?: RouteGuard<T>;
    /** Runs the call; it receives the request's context and returns a value the server encodes or a writable it runs. */
    handler: (ctx: RequestContext, argument: T) => Promise<unknown>;
}

/** Check one route's input, guard, and handler against one type, then erase it for the route table. */
export function defineRoute<T>(route: Route<T>): Route {
    return route as Route;
}

/** 
 * The router a server drives: one request in, one answer out. 
 * 
 * @see {ApiRouter} to create an instance of the router
 **/
export interface HttpRouter {
    /** Match, read, decode, validate, and call one request; the result is a value or a writable. */
    handle(request: IncomingMessage): Promise<unknown>;
}

/** A router over a route table, building one request context per call over the app's driver. */
export class ApiRouter implements HttpRouter {
    readonly #app: AppContext;
    readonly #byKey: Map<string, Route>;
    readonly #byId: Map<string, Route>;

    constructor(app: AppContext, routes: Route[]) {
        this.#app = app;
        this.#byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
        this.#byId = new Map(routes.map((route) => [route.id, route]));
    }

    /** Resolve a request by its method and path. */
    #resolve(method: string, path: string): Route | undefined {
        return this.#byKey.get(`${method} ${path}`);
    }

    /**
     * Match, read, decode, validate, and call one request.
     * @throws {PayloadTooLargeError} when the body passes the byte cap
     * @throws {NotFoundError} when no route matches the method and path
     * @throws {RequestError} when the argument does not decode
     * @throws {ValidationError} when the route's schema rejects the argument
     */
    async handle(request: IncomingMessage): Promise<unknown> {
        const url = new URL(request.url ?? "/", "http://localhost");
        // A missing method is read as `GET`, the method a request without one carries.
        const method = request.method ?? "GET";
        // One context per request, so a route never reaches for a dependency the router did not hand it.
        const ctx = new RequestContext(this.#app.driver.createExecutor(), request);
        const body = await readBody(request);

        if (method === "POST" && url.pathname === GROUP_PATH) {
            // A group entry names an operation rather than a verb and a path, so it resolves by id.
            return await handleGroup(ctx, (id) => this.#byId.get(id), body);
        }

        const route = this.#resolve(method, url.pathname);
        if (!route) {
            throw new NotFoundError("no route");
        }

        // A `query` call carries its argument in `q`; a `body` call in the request body.
        const encoded =
            route.source === "query" ? (url.searchParams.get("q") ?? undefined) : body === "" ? undefined : body;

        let value: unknown;
        try {
            value = encoded === undefined ? undefined : decode(encoded);
        } catch {
            throw new RequestError("malformed request");
        }

        const parsed = route.input.safeParse(value);
        if (!parsed.success) {
            throw new ValidationError("invalid request", { issues: parsed.error.issues });
        }

        await route.guard?.(ctx, parsed.data);
        return await route.handler(ctx, parsed.data);
    }
}
