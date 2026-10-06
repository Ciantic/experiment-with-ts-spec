/** Unit tests for the hand-written router, over fixture routes. See docs/testing.md. */
import { parse as decode, stringify } from "devalue";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { createRouter, GROUP_PATH, type Route, type RouteInput } from "./router.ts";

/** A schema stand-in that accepts any argument; the router test is not about Zod. */
const accepts: RouteInput = {
    safeParse: (value) => ({ success: true, data: value }),
};

/** A schema stand-in that always rejects, so the failure path is exercised without Zod. */
const rejects: RouteInput = {
    safeParse: () => ({ success: false, error: { issues: ["bad"] } }),
};

/**
 * A `SqlExecutor` over no database, recording the boundary each group opens and the SQL
 * each handler runs. It nests the way the real port does, one level deeper per
 * boundary, so a test can tell a top-level transaction from a savepoint.
 */
function createDb() {
    const boundaries: string[] = [];
    const statements: string[] = [];
    const handle = (depth: number): SqlExecutor => ({
        query: async (sql) => {
            statements.push(sql);
            return { rows: [] };
        },
        transaction: async (run) => {
            boundaries.push(depth === 0 ? "begin" : `savepoint ${depth}`);
            return await run(handle(depth + 1));
        },
    });
    return { db: handle(0), boundaries, statements };
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
});

/** One call entry of a group body, as the client encodes it. */
function callEntry(method: string, path: string, argument: unknown) {
    return { call: { method, path, argument } };
}

/** A whole group body, as the client encodes it. */
function groupBody(kind: "batch" | "transaction" | "attempt", calls: unknown[]): string {
    return stringify({ group: { kind, calls } });
}

/** The group route's request, with `body` already a string. */
function groupRequest(body: string) {
    return { method: "POST", url: GROUP_PATH, body };
}

describe("createRouter groups", () => {
    it("runs the calls of a group in order and answers their results", async () => {
        const router = createRouter(db, [echoRoute(), echoRoute({ path: "/other" })]);

        const response = await router.handle(
            groupRequest(
                groupBody("batch", [
                    callEntry("POST", "/echo", { n: 1 }),
                    callEntry("POST", "/other", { n: 2 }),
                ]),
            ),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("carries a write's result as null, as a single call does", async () => {
        const router = createRouter(db, [echoRoute({ handler: async () => undefined })]);

        const response = await router.handle(groupRequest(groupBody("batch", [callEntry("POST", "/echo", {})])));

        expect(decode(response.body)).toEqual([null]);
    });

    it("runs a PUT entry, which a group names for an upsert", async () => {
        const router = createRouter(db, [echoRoute({ method: "PUT" })]);

        const response = await router.handle(
            groupRequest(groupBody("transaction", [callEntry("PUT", "/echo", { n: 1 })])),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ n: 1 }]);
    });

    it("refuses a group whose call names no route, without running any of it", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle(groupRequest(groupBody("batch", [callEntry("POST", "/missing", {})])));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "no route", path: [0] });
    });

    it("validates every call before running any of them", async () => {
        const ran: unknown[] = [];
        const router = createRouter(db, [
            echoRoute({
                handler: async (_db, argument) => {
                    ran.push(argument);
                    return argument;
                },
            }),
            echoRoute({ path: "/strict", input: rejects }),
        ]);

        const response = await router.handle(
            groupRequest(
                groupBody("batch", [
                    callEntry("POST", "/echo", { first: true }),
                    callEntry("POST", "/strict", { second: true }),
                ]),
            ),
        );

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "invalid request", path: [1], issues: ["bad"] });
        expect(ran).toEqual([]);
    });

    it("refuses a body that is a lone call rather than a group", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle(groupRequest(stringify(callEntry("POST", "/echo", {}))));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "the body must be a group", path: [] });
    });

    it("refuses a malformed group body", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle(groupRequest(stringify({ group: { kind: "nope", calls: [] } })));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "a group kind must be batch, transaction, or attempt", path: [] });
    });

    it("answers 400 for a group body that is not decodable", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle(groupRequest("not devalue"));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "malformed request" });
    });

    it("opens no boundary for a batch", async () => {
        const router = createRouter(db, [echoRoute()]);

        await router.handle(groupRequest(groupBody("batch", [callEntry("POST", "/echo", {}), callEntry("POST", "/echo", {})])));

        expect(fake.boundaries).toEqual([]);
    });

    it("opens one boundary for a transaction, and a handler query runs on its executor", async () => {
        const router = createRouter(db, [
            echoRoute({
                handler: async (executor) => {
                    await executor.query("select 1");
                    return null;
                },
            }),
        ]);

        await router.handle(groupRequest(groupBody("transaction", [callEntry("POST", "/echo", {})])));

        expect(fake.boundaries).toEqual(["begin"]);
        expect(fake.statements).toEqual(["select 1"]);
    });

    it("nests a transaction in a transaction as a savepoint, and the results nest", async () => {
        const router = createRouter(db, [echoRoute(), echoRoute({ path: "/other" })]);

        const response = await router.handle(
            groupRequest(
                groupBody("transaction", [
                    {
                        group: {
                            kind: "transaction",
                            calls: [
                                callEntry("POST", "/echo", { n: 1 }),
                                callEntry("POST", "/other", { n: 2 }),
                            ],
                        },
                    },
                    callEntry("POST", "/echo", { n: 3 }),
                ]),
            ),
        );

        expect(fake.boundaries).toEqual(["begin", "savepoint 1"]);
        expect(decode(response.body)).toEqual([[{ n: 1 }, { n: 2 }], { n: 3 }]);
    });

    it("opens two boundaries for two sibling transactions", async () => {
        const router = createRouter(db, [echoRoute()]);

        await router.handle(
            groupRequest(
                groupBody("batch", [
                    { group: { kind: "transaction", calls: [callEntry("POST", "/echo", {})] } },
                    { group: { kind: "transaction", calls: [callEntry("POST", "/echo", {})] } },
                ]),
            ),
        );

        expect(fake.boundaries).toEqual(["begin", "begin"]);
    });

    it("opens a nested transaction inside a batch as its own boundary", async () => {
        const router = createRouter(db, [echoRoute()]);

        await router.handle(
            groupRequest(
                groupBody("batch", [
                    callEntry("POST", "/echo", {}),
                    { group: { kind: "transaction", calls: [callEntry("POST", "/echo", {})] } },
                ]),
            ),
        );

        expect(fake.boundaries).toEqual(["begin"]);
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

    it("gives a handler that asks inside a transaction group a savepoint of its own", async () => {
        const router = createRouter(db, [
            echoRoute({
                handler: async (executor) => await executor.transaction(async () => null),
            }),
        ]);

        await router.handle(groupRequest(groupBody("transaction", [callEntry("POST", "/echo", {})])));

        expect(fake.boundaries).toEqual(["begin", "savepoint 1"]);
    });

    it("opens the handler's own boundary inside a batch, which has none", async () => {
        const router = createRouter(db, [
            echoRoute({
                handler: async (executor) => await executor.transaction(async () => null),
            }),
        ]);

        await router.handle(groupRequest(groupBody("batch", [callEntry("POST", "/echo", {})])));

        expect(fake.boundaries).toEqual(["begin"]);
    });

    it("reports an attempt's failure instead of failing the request", async () => {
        const router = createRouter(db, [
            echoRoute({ path: "/inner", handler: async () => {
                throw Object.assign(new Error("version conflict"), { code: "40001" });
            } }),
        ]);

        const response = await router.handle(
            groupRequest(
                groupBody("batch", [
                    { group: { kind: "attempt", calls: [callEntry("POST", "/inner", {})] } },
                ]),
            ),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([
            { ok: false, error: { message: "version conflict", path: [0, 0] } },
        ]);
    });

    it("answers an attempt's success with its results", async () => {
        const router = createRouter(db, [echoRoute()]);

        const response = await router.handle(
            groupRequest(
                groupBody("attempt", [callEntry("POST", "/echo", { n: 1 })]),
            ),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual({ ok: true, value: [{ n: 1 }] });
    });

    it("gives an attempt a savepoint, so its failure leaves the outer group running", async () => {
        const router = createRouter(db, [
            echoRoute(),
            echoRoute({ path: "/inner", handler: async () => {
                throw new Error("boom");
            } }),
        ]);

        const response = await router.handle(
            groupRequest(
                groupBody("transaction", [
                    callEntry("POST", "/echo", { first: true }),
                    { group: { kind: "attempt", calls: [callEntry("POST", "/inner", {})] } },
                    callEntry("POST", "/echo", { last: true }),
                ]),
            ),
        );

        expect(fake.boundaries).toEqual(["begin", "savepoint 1"]);
        expect(decode(response.body)).toEqual([
            { first: true },
            { ok: false, error: { message: "boom", path: [1, 0] } },
            { last: true },
        ]);
    });

    it("does not swallow a failure that is not its own", async () => {
        const router = createRouter(db, [
            echoRoute({ handler: async () => {
                throw new Error("outer boom");
            } }),
        ]);

        const response = await router.handle(
            groupRequest(
                groupBody("transaction", [
                    { group: { kind: "attempt", calls: [callEntry("POST", "/echo", {})] } },
                ]),
            ),
        );

        // The attempt caught it, so the request answers its marker rather than a failure.
        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([
            { ok: false, error: { message: "outer boom", path: [0, 0] } },
        ]);
    });

    it("names the entry that failed by its path in the tree", async () => {
        const router = createRouter(db, [
            echoRoute(),
            echoRoute({ path: "/inner", handler: async () => {
                throw Object.assign(new Error("version conflict"), { code: "40001" });
            } }),
        ]);

        const response = await router.handle(
            groupRequest(
                groupBody("transaction", [
                    callEntry("POST", "/echo", {}),
                    { group: { kind: "batch", calls: [callEntry("POST", "/inner", {})] } },
                ]),
            ),
        );

        expect(response.status).toBe(409);
        expect(JSON.parse(response.body)).toEqual({ error: "version conflict", path: [1, 0] });
    });
});
