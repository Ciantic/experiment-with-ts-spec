/** Unit tests for the hand-written router, over fixture routes. See docs/testing.md. */
import { Buffer } from "node:buffer";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { stringify } from "devalue";
import { beforeEach, describe, expect, it } from "vitest";
import {
    BadGroupError,
    NotFoundError,
    PayloadTooLargeError,
    QueryError,
    RequestError,
    ShortWriteError,
    ValidationError,
    VersionConflictError,
} from "sdk/errors.ts";
import type { AppContext } from "../context.ts";
import { SqlDriver, type SqlSession } from "../db/sql-driver.ts";
import { statusFor } from "./api-http-response.ts";
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
class RecordingDriver extends SqlDriver {
    readonly statements: string[] = [];

    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        _parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }> {
        this.statements.push(sql);
        return { rows: [], affectedRows: 0 };
    }

    async connect(): Promise<SqlSession> {
        return {
            query: <Row extends Record<string, unknown> = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => this.query<Row>(sql, parameters),
            release: () => {},
        };
    }

    async exec(): Promise<unknown> {
        return undefined;
    }

    async close(): Promise<void> {}
}

/** A recording driver, plus the statements it saw. */
function createDriver() {
    const driver = new RecordingDriver();
    return { driver, statements: driver.statements };
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

/** The error a request failed with, so its type and fields are both assertable. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (thrown) {
        return thrown;
    }
    throw new Error("expected the request to fail");
}

describe("createRouter", () => {
    it("throws NotFoundError for a call the table does not expose", async () => {
        const router = createRouter(app, [echoRoute()]);

        const thrown = await failure(router.handle(request("POST", "/missing")));

        expect(thrown).toBeInstanceOf(NotFoundError);
    });

    it("matches on the method as well as the path", async () => {
        const router = createRouter(app, [echoRoute()]);

        const thrown = await failure(router.handle(request("PATCH", "/echo")));

        expect(thrown).toBeInstanceOf(NotFoundError);
    });

    it("serves a PUT, the verb an upsert reaches the server with", async () => {
        const router = createRouter(app, [echoRoute({ method: "PUT" })]);

        expect(await router.handle(request("PUT", "/echo", stringify(payload)))).toEqual(payload);
    });

    it("throws RequestError for a body that is not decodable", async () => {
        const router = createRouter(app, [echoRoute()]);

        const thrown = await failure(router.handle(request("POST", "/echo", "not devalue")));

        expect(thrown).toBeInstanceOf(RequestError);
        expect(thrown).toMatchObject({ status: 400, kind: "request" });
    });

    it("refuses a body past the transport's cap", async () => {
        const router = createRouter(app, [echoRoute()]);

        const thrown = await failure(router.handle(request("POST", "/echo", "x".repeat(1_000_001))));

        expect(thrown).toBeInstanceOf(PayloadTooLargeError);
        expect(thrown).toMatchObject({ status: 413, kind: "payload-too-large" });
    });

    it("throws ValidationError with the issues when the schema rejects", async () => {
        const router = createRouter(app, [echoRoute({ input: rejects })]);

        const thrown = await failure(router.handle(request("POST", "/echo")));

        expect(thrown).toBeInstanceOf(ValidationError);
        expect(thrown).toMatchObject({ status: 400, kind: "validation", issues: ["bad"] });
    });

    it("passes the decoded body to the handler and answers the result", async () => {
        const router = createRouter(app, [echoRoute()]);

        expect(await router.handle(request("POST", "/echo", stringify(payload)))).toEqual(payload);
    });

    it("decodes the query parameter for a call that carries its argument there", async () => {
        const router = createRouter(app, [queryRoute()]);

        expect(await router.handle(request("GET", queryUrl(payload)))).toEqual(payload);
    });

    it("reads the argument from where the route says, ignoring the other", async () => {
        const router = createRouter(app, [queryRoute(), echoRoute()]);

        const fromQuery = await router.handle(
            request("GET", queryUrl({ from: "query" }), stringify({ from: "body" })),
        );
        const fromBody = await router.handle(
            request("POST", queryUrl({ from: "query" }), stringify({ from: "body" })),
        );

        expect(fromQuery).toEqual({ from: "query" });
        expect(fromBody).toEqual({ from: "body" });
    });

    it("throws RequestError for a query parameter that is not decodable", async () => {
        const router = createRouter(app, [queryRoute()]);

        const thrown = await failure(router.handle(request("GET", "/echo?q=not%20devalue")));

        expect(thrown).toBeInstanceOf(RequestError);
        expect(thrown).toMatchObject({ status: 400, kind: "request" });
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

        const value = await router.handle(request("GET", "/echo"));

        expect(value).toBeUndefined();
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

    it("answers an undefined result as undefined", async () => {
        const router = createRouter(app, [echoRoute({ handler: async () => undefined })]);

        expect(await router.handle(request("POST", "/echo"))).toBeUndefined();
    });

    it("propagates a driver failure with its SQLSTATE", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("version conflict"), { code: "40001" });
            },
        });
        const router = createRouter(app, [route]);

        const thrown = await failure(router.handle(request("POST", "/echo")));

        expect(thrown).toBeInstanceOf(Error);
        expect((thrown as Error).message).toBe("version conflict");
        expect((thrown as { code?: unknown }).code).toBe("40001");
    });

    it("propagates an AppError unchanged", async () => {
        const cases = [new QueryError("bad read"), new VersionConflictError("stale"), new ShortWriteError("lost rows")];

        for (const thrown of cases) {
            const router = createRouter(app, [
                echoRoute({
                    handler: async () => {
                        throw thrown;
                    },
                }),
            ]);

            expect(await failure(router.handle(request("POST", "/echo")))).toBe(thrown);
        }
    });

    it("maps a unique violation to 409 and an unknown failure to 500", () => {
        expect(statusFor(Object.assign(new Error("duplicate"), { code: "23505" }))).toBe(409);
        expect(statusFor(new Error("boom"))).toBe(500);
    });

    it("maps a check violation to 400", () => {
        expect(statusFor(Object.assign(new Error("value rejected by a row constraint"), { code: "23514" }))).toBe(400);
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

        const value = await router.handle(request("POST", GROUP_PATH, body));

        expect(value).toEqual([{ n: 1 }]);
    });

    it("resolves a group entry by its operation id, not its path", async () => {
        const router = createRouter(app, [echoRoute()]);
        const body = stringify({
            group: { kind: "batch", calls: [{ call: { operation: "/echo", argument: { n: 1 } } }] },
        });

        const thrown = await failure(router.handle(request("POST", GROUP_PATH, body)));

        expect(thrown).toBeInstanceOf(BadGroupError);
        expect(thrown).toMatchObject({ status: 400, kind: "bad-group", path: [0] });
    });
});
