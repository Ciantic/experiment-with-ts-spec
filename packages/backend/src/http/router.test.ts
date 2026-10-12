/** Unit tests for the hand-written router, over fixture routes. See docs/testing.md. */
import { parse as decode, stringify } from "devalue";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { GROUP_PATH } from "./group-handler.ts";
import { createRouter, type Route, type RouteInput } from "./router.ts";

/** A schema stand-in that accepts any argument; the router test is not about Zod. */
const accepts: RouteInput = {
    safeParse: (value) => ({ success: true, data: value }),
};

/** A schema stand-in that always rejects, so the failure path is exercised without Zod. */
const rejects: RouteInput = {
    safeParse: () => ({ success: false, error: { issues: ["bad"] } }),
};

/**
 * A `SqlExecutor` over no database, recording the boundary a handler's own `transaction`
 * opens.
 */
function createDb() {
    const boundaries: string[] = [];
    const handle = (): SqlExecutor => ({
        query: async () => ({ rows: [] }),
        transaction: async (run) => {
            boundaries.push("begin");
            return await run(handle());
        },
        transactionWith: async () => {
            throw new Error("no boundary here opens with modes");
        },
    });
    return { db: handle(), boundaries };
}

let fake: ReturnType<typeof createDb>;
let db: SqlExecutor;

beforeEach(() => {
    fake = createDb();
    db = fake.db;
});

/** A route that echoes its argument back, so the codec round-trip is observable. */
function echoRoute(overrides: Partial<Route> = {}): Route {
    return {
        method: "POST",
        path: "/echo",
        source: "body",
        input: accepts,
        handler: async (_db, argument) => argument,
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
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle({ method: "POST", url: "/missing", body: "" });

        expect(response.status).toBe(404);
    });

    it("matches on the method as well as the path", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle({ method: "PATCH", url: "/echo", body: "" });

        expect(response.status).toBe(404);
    });

    it("serves a PUT, the verb an upsert reaches the server with", async () => {
        const router = createRouter(db, [echoRoute({ method: "PUT" })]);

        const response = await router.handle({ method: "PUT", url: "/echo", body: stringify(payload) });

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual(payload);
    });

    it("answers 400 for a body that is not decodable", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle({ method: "POST", url: "/echo", body: "not devalue" });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "malformed request" });
    });

    it("answers 400 with the issues when the schema rejects", async () => {
        const router = createRouter(db, [echoRoute({ input: rejects })]);

        const response = await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "invalid request", issues: ["bad"] });
    });

    it("passes the decoded body to the handler and encodes the result", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle({ method: "POST", url: "/echo", body: stringify(payload) });

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual(payload);
    });

    it("decodes the query parameter for a call that carries its argument there", async () => {
        const router = createRouter(db, [queryRoute()]);

        const response = await router.handle({ method: "GET", url: queryUrl(payload), body: "" });

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual(payload);
    });

    it("reads the argument from where the route says, ignoring the other", async () => {
        const router = createRouter(db, [queryRoute(), echoRoute()]);

        const fromQuery = await router.handle({
            method: "GET",
            url: queryUrl({ from: "query" }),
            body: stringify({ from: "body" }),
        });
        const fromBody = await router.handle({
            method: "POST",
            url: queryUrl({ from: "query" }),
            body: stringify({ from: "body" }),
        });

        expect(decode(fromQuery.body)).toEqual({ from: "query" });
        expect(decode(fromBody.body)).toEqual({ from: "body" });
    });

    it("answers 400 for a query parameter that is not decodable", async () => {
        const router = createRouter(db, [queryRoute()]);

        const response = await router.handle({ method: "GET", url: "/echo?q=not%20devalue", body: "" });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "malformed request" });
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
        const router = createRouter(db, [route]);

        const response = await router.handle({ method: "GET", url: "/echo", body: "" });

        expect(response.status).toBe(200);
        expect(seen).toEqual([undefined]);
    });

    it("routes the handler's queries through the executor of the request", async () => {
        const statements: string[] = [];
        const route = echoRoute({
            handler: async (executor) => {
                await executor.query("select 1");
                return null;
            },
        });
        const own = createDb();
        own.db.query = async (sql) => {
            statements.push(sql);
            return { rows: [] };
        };
        const router = createRouter(own.db, [route]);

        await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(statements).toEqual(["select 1"]);
    });

    it("encodes an undefined result as null", async () => {
        const router = createRouter(db, [echoRoute({ handler: async () => undefined })]);

        const response = await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(response.status).toBe(200);
        expect(decode(response.body)).toBeNull();
    });

    it("maps the version conflict to 409", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("version conflict"), { code: "40001" });
            },
        });
        const router = createRouter(db, [route]);

        const response = await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(response.status).toBe(409);
        expect(JSON.parse(response.body)).toEqual({ error: "version conflict" });
    });

    it("maps a unique violation to 409 and an unknown failure to 500", async () => {
        const violating = createRouter(db, [
            echoRoute({
                handler: async () => {
                    throw Object.assign(new Error("duplicate"), { code: "23505" });
                },
            }),
        ]);
        const broken = createRouter(db, [
            echoRoute({
                handler: async () => {
                    throw new Error("boom");
                },
            }),
        ]);

        expect((await violating.handle({ method: "POST", url: "/echo", body: "" })).status).toBe(409);
        expect((await broken.handle({ method: "POST", url: "/echo", body: "" })).status).toBe(500);
    });

    it("maps a check violation to 400", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("value rejected by a row constraint"), { code: "23514" });
            },
        });
        const router = createRouter(db, [route]);

        const response = await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "value rejected by a row constraint" });
    });

    it("opens a boundary when a handler asks for one, and no other", async () => {
        const router = createRouter(db, [
            echoRoute({
                handler: async (executor) => await executor.transaction(async () => null),
            }),
        ]);

        await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(fake.boundaries).toEqual(["begin"]);
    });

    it("serves the group path, handing the body to the group handler", async () => {
        const router = createRouter(db, [echoRoute()]);
        const body = stringify({
            group: { kind: "batch", calls: [{ call: { method: "POST", path: "/echo", argument: { n: 1 } } }] },
        });

        const response = await router.handle({ method: "POST", url: GROUP_PATH, body });

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ n: 1 }]);
    });
});
