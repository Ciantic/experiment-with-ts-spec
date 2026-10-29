/** Unit tests for the hand-written router, over fixture routes. See docs/testing.md. */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { parse as decode, stringify } from "devalue";
import { beforeEach, describe, expect, it } from "vitest";
import { QueryError, ShortWriteError, VersionConflictError } from "sdk/errors.ts";
import type { AppContext } from "../context.ts";
import type { SqlDriver, SqlSession } from "../db/sql-driver.ts";
import { statusFor } from "./http-response.ts";
import { GROUP_PATH } from "./group-handler.ts";
import { createRouter, type Route, type RouteInput } from "./router.ts";

/** The request the server hands the router: a stream over `body`, plus the method and URL Node sets on it. */
function request(method: string, url: string, body = ""): IncomingMessage {
    const chunks = body === "" ? [] : [Buffer.from(body)];
    return Object.assign(Readable.from(chunks), { method, url }) as unknown as IncomingMessage;
}

/** A schema stand-in that accepts any argument; the router test is not about Zod. */
const accepts: RouteInput = {
    safeParse: (value) => ({ success: true, data: value }),
};

/** A schema stand-in that always rejects, so the failure path is exercised without Zod. */
const rejects: RouteInput = {
    safeParse: () => ({ success: false, error: { issues: ["bad"] } }),
};

/** A driver over no database, recording every statement that runs through it. */
function createDriver() {
    const statements: string[] = [];
    const run = async (sql: string) => {
        statements.push(sql);
        return { rows: [], affectedRows: 0 };
    };
    const session: SqlSession = { query: run, release: () => {} };
    const driver: SqlDriver = { query: run, connect: async () => session, exec: async () => {}, close: async () => {} };
    return { driver, statements };
}

/** The context startup builds, over a recording driver, so a request's executor is observable. */
function createApp() {
    const { driver, statements } = createDriver();
    return { app: { driver }, statements };
}

let app: AppContext;
let statements: string[];

beforeEach(() => {
    ({ app, statements } = createApp());
});

/** A route that echoes its argument back, so the codec round-trip is observable. */
function echoRoute(overrides: Partial<Route> = {}): Route {
    return {
        id: "echo",
        method: "POST",
        path: "/echo",
        source: "body",
        input: accepts,
        handler: async (_ctx, argument) => argument,
        ...overrides,
    };
}

/** The same echo, with its argument in the query string. */
function queryRoute(overrides: Partial<Route> = {}): Route {
    return echoRoute({ method: "GET", source: "query", ...overrides });
}

/** `/echo` with the argument devalue-encoded into `q`, as the client sends it. */
function queryUrl(argument: unknown): string {
    return `/echo?q=${encodeURIComponent(stringify(argument))}`;
}

/** A value with both of the types a JSON encoding would lose. */
const payload = { at: new Date("2026-01-02T03:04:05.000Z"), revision: 7n, name: "widget" };

describe("createRouter", () => {
    it("answers 404 for a call the table does not expose", async () => {
        const router = createRouter(app, [echoRoute()]);

        const response = await router.handle(request("POST", "/missing"));

        expect(response.status).toBe(404);
    });

    it("matches on the method as well as the path", async () => {
        const router = createRouter(app, [echoRoute()]);

        const response = await router.handle(request("PATCH", "/echo"));

        expect(response.status).toBe(404);
    });

    it("serves a PUT, the verb an upsert reaches the server with", async () => {
        const router = createRouter(app, [echoRoute({ method: "PUT" })]);

        const response = await router.handle(request("PUT", "/echo", stringify(payload)));

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual(payload);
    });

    it("answers 400 for a body that is not decodable", async () => {
        const router = createRouter(app, [echoRoute()]);

        const response = await router.handle(request("POST", "/echo", "not devalue"));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "malformed request", kind: "request" });
    });

    it("refuses a body past the transport's cap", async () => {
        const router = createRouter(app, [echoRoute()]);

        const response = await router.handle(request("POST", "/echo", "x".repeat(1_000_001)));

        expect(response.status).toBe(413);
        expect(JSON.parse(response.body)).toEqual({ error: "request body too large", kind: "payload-too-large" });
    });

    it("answers 400 with the issues when the schema rejects", async () => {
        const router = createRouter(app, [echoRoute({ input: rejects })]);

        const response = await router.handle(request("POST", "/echo"));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "invalid request", kind: "validation", issues: ["bad"] });
    });

    it("passes the decoded body to the handler and encodes the result", async () => {
        const router = createRouter(app, [echoRoute()]);

        const response = await router.handle(request("POST", "/echo", stringify(payload)));

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual(payload);
    });

    it("decodes the query parameter for a call that carries its argument there", async () => {
        const router = createRouter(app, [queryRoute()]);

        const response = await router.handle(request("GET", queryUrl(payload)));

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual(payload);
    });

    it("reads the argument from where the route says, ignoring the other", async () => {
        const router = createRouter(app, [queryRoute(), echoRoute()]);

        const fromQuery = await router.handle(
            request("GET", queryUrl({ from: "query" }), stringify({ from: "body" })),
        );
        const fromBody = await router.handle(
            request("POST", queryUrl({ from: "query" }), stringify({ from: "body" })),
        );

        expect(decode(fromQuery.body)).toEqual({ from: "query" });
        expect(decode(fromBody.body)).toEqual({ from: "body" });
    });

    it("answers 400 for a query parameter that is not decodable", async () => {
        const router = createRouter(app, [queryRoute()]);

        const response = await router.handle(request("GET", "/echo?q=not%20devalue"));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "malformed request", kind: "request" });
    });

    it("decodes an absent argument as undefined, leaving the schema to reject it", async () => {
        const seen: unknown[] = [];
        const route = queryRoute({
            input: {
                safeParse: (value) => {
                    seen.push(value);
                    return { success: true, data: value };
                },
            },
        });
        const router = createRouter(app, [route]);

        const response = await router.handle(request("GET", "/echo"));

        expect(response.status).toBe(200);
        expect(seen).toEqual([undefined]);
    });

    it("routes the handler's queries through the executor of the request", async () => {
        const route = echoRoute({
            handler: async (ctx) => {
                await ctx.db.query("select 1");
                return null;
            },
        });
        const own = createApp();
        const router = createRouter(own.app, [route]);

        await router.handle(request("POST", "/echo"));

        expect(own.statements).toEqual(["select 1"]);
    });

    it("encodes an undefined result as null", async () => {
        const router = createRouter(app, [echoRoute({ handler: async () => undefined })]);

        const response = await router.handle(request("POST", "/echo"));

        expect(response.status).toBe(200);
        expect(decode(response.body)).toBeNull();
    });

    it("maps the version conflict to 409", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("version conflict"), { code: "40001" });
            },
        });
        const router = createRouter(app, [route]);

        const response = await router.handle(request("POST", "/echo"));

        expect(response.status).toBe(409);
        expect(JSON.parse(response.body)).toEqual({ error: "version conflict" });
    });

    it("maps an AppError by the status it carries", async () => {
        const cases = [
            { thrown: new QueryError("bad read"), status: 400 },
            { thrown: new VersionConflictError("stale"), status: 409 },
            { thrown: new ShortWriteError("lost rows"), status: 500 },
        ];

        for (const { thrown, status } of cases) {
            const router = createRouter(app, [
                echoRoute({
                    handler: async () => {
                        throw thrown;
                    },
                }),
            ]);

            const response = await router.handle(request("POST", "/echo"));

            expect(response.status).toBe(status);
            expect(JSON.parse(response.body)).toEqual({ error: thrown.message, kind: thrown.kind });
        }
    });

    it("maps a unique violation to 409 and an unknown failure to 500", async () => {
        const violating = createRouter(app, [
            echoRoute({
                handler: async () => {
                    throw Object.assign(new Error("duplicate"), { code: "23505" });
                },
            }),
        ]);
        const broken = createRouter(app, [
            echoRoute({
                handler: async () => {
                    throw new Error("boom");
                },
            }),
        ]);

        expect((await violating.handle(request("POST", "/echo"))).status).toBe(409);
        expect((await broken.handle(request("POST", "/echo"))).status).toBe(500);
    });

    it("maps a check violation to 400", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("value rejected by a row constraint"), { code: "23514" });
            },
        });
        const router = createRouter(app, [route]);

        const response = await router.handle(request("POST", "/echo"));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "value rejected by a row constraint" });
    });

    it("does not read an inherited property as a SQLSTATE", () => {
        expect(statusFor({ code: "constructor" })).toBe(500);
        expect(statusFor({ code: "toString" })).toBe(500);
        expect(statusFor({ code: "40001" })).toBe(409);
    });

    it("opens a boundary when a handler asks for one, and no other", async () => {
        const router = createRouter(app, [
            echoRoute({
                handler: async (ctx) => await ctx.db.transaction(async () => null),
            }),
        ]);

        await router.handle(request("POST", "/echo"));

        expect(statements).toEqual(["begin", "commit"]);
    });

    it("serves the group path, handing the body to the group handler", async () => {
        const router = createRouter(app, [echoRoute()]);
        const body = stringify({
            group: { kind: "batch", calls: [{ call: { operation: "echo", argument: { n: 1 } } }] },
        });

        const response = await router.handle(request("POST", GROUP_PATH, body));

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ n: 1 }]);
    });

    it("resolves a group entry by its operation id, not its path", async () => {
        const router = createRouter(app, [echoRoute()]);
        const body = stringify({
            group: { kind: "batch", calls: [{ call: { operation: "/echo", argument: { n: 1 } } }] },
        });

        const response = await router.handle(request("POST", GROUP_PATH, body));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "no operation `/echo`", kind: "bad-group", path: [0] });
    });
});
