/** Unit tests for the group entry point, over fixture routes. See docs/testing.md and docs/transactions.md. */
import { parse as decode, stringify } from "devalue";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor, TransactionOptions } from "../db/sql-executor.ts";
import { handleGroup } from "./group-handler.ts";
import type { HttpResponse, Route, RouteInput } from "./router.ts";

/** A schema stand-in that accepts any argument; the group test is not about Zod. */
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
    const modes: Array<TransactionOptions | undefined> = [];
    const handle = (depth: number): SqlExecutor => ({
        query: async (sql) => {
            statements.push(sql);
            return { rows: [] };
        },
        transaction: async (...args) => {
            const [options, run] = args.length === 1 ? [undefined, args[0]] : [args[0], args[1]];
            modes.push(options);
            boundaries.push(depth === 0 ? "begin" : `savepoint ${depth}`);
            return await run(handle(depth + 1));
        },
    });
    return { db: handle(0), boundaries, statements, modes };
}

let fake: ReturnType<typeof createDb>;
let db: SqlExecutor;

beforeEach(() => {
    fake = createDb();
    db = fake.db;
});

/** A route that echoes its argument back, so the results of a group are observable. */
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

/** One call entry of a group body, as the client encodes it. */
function callEntry(method: string, path: string, argument: unknown) {
    return { call: { method, path, argument } };
}

/** A whole group body, as the client encodes it. */
function groupBody(kind: "batch" | "transaction" | "attempt", calls: unknown[], options?: unknown): string {
    return stringify({ group: { kind, ...(options === undefined ? {} : { options }), calls } });
}

/** Handle one body against a fixture route table, resolving calls the way the router does. */
async function handle(routes: Route[], body: string): Promise<HttpResponse> {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));
    return await handleGroup(db, (method, path) => byKey.get(`${method} ${path}`), body);
}

describe("handleGroup", () => {
    it("runs the calls of a group in order and answers their results", async () => {
        const response = await handle(
            [echoRoute(), echoRoute({ path: "/other" })],
            groupBody("batch", [callEntry("POST", "/echo", { n: 1 }), callEntry("POST", "/other", { n: 2 })]),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ n: 1 }, { n: 2 }]);
    });

    it("carries a write's result as null, as a single call does", async () => {
        const response = await handle(
            [echoRoute({ handler: async () => undefined })],
            groupBody("batch", [callEntry("POST", "/echo", {})]),
        );

        expect(decode(response.body)).toEqual([null]);
    });

    it("runs a PUT entry, which a group names for an upsert", async () => {
        const response = await handle(
            [echoRoute({ method: "PUT" })],
            groupBody("transaction", [callEntry("PUT", "/echo", { n: 1 })]),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ n: 1 }]);
    });

    it("refuses a group whose call names no route, without running any of it", async () => {
        const response = await handle([echoRoute()], groupBody("batch", [callEntry("POST", "/missing", {})]));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "no route", path: [0] });
    });

    it("validates every call before running any of them", async () => {
        const ran: unknown[] = [];
        const routes = [
            echoRoute({
                handler: async (_db, argument) => {
                    ran.push(argument);
                    return argument;
                },
            }),
            echoRoute({ path: "/strict", input: rejects }),
        ];

        const response = await handle(
            routes,
            groupBody("batch", [callEntry("POST", "/echo", { first: true }), callEntry("POST", "/strict", { second: true })]),
        );

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "invalid request", path: [1], issues: ["bad"] });
        expect(ran).toEqual([]);
    });

    it("refuses a body that is a lone call rather than a group", async () => {
        const response = await handle([echoRoute()], stringify(callEntry("POST", "/echo", {})));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "the body must be a group", path: [] });
    });

    it("refuses a malformed group body", async () => {
        const response = await handle([echoRoute()], stringify({ group: { kind: "nope", calls: [] } }));

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "a group kind must be batch, transaction, or attempt", path: [] });
    });

    it("answers 400 for a group body that is not decodable", async () => {
        const response = await handle([echoRoute()], "not devalue");

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ error: "malformed request" });
    });

    it("opens no boundary for a batch", async () => {
        await handle([echoRoute()], groupBody("batch", [callEntry("POST", "/echo", {}), callEntry("POST", "/echo", {})]));

        expect(fake.boundaries).toEqual([]);
    });

    it("opens one boundary for a transaction, and a handler query runs on its executor", async () => {
        await handle(
            [
                echoRoute({
                    handler: async (executor) => {
                        await executor.query("select 1");
                        return null;
                    },
                }),
            ],
            groupBody("transaction", [callEntry("POST", "/echo", {})]),
        );

        expect(fake.boundaries).toEqual(["begin"]);
        expect(fake.statements).toEqual(["select 1"]);
    });

    it("nests a transaction in a transaction as a savepoint, and the results nest", async () => {
        const response = await handle(
            [echoRoute(), echoRoute({ path: "/other" })],
            groupBody("transaction", [
                {
                    group: {
                        kind: "transaction",
                        calls: [callEntry("POST", "/echo", { n: 1 }), callEntry("POST", "/other", { n: 2 })],
                    },
                },
                callEntry("POST", "/echo", { n: 3 }),
            ]),
        );

        expect(fake.boundaries).toEqual(["begin", "savepoint 1"]);
        expect(decode(response.body)).toEqual([[{ n: 1 }, { n: 2 }], { n: 3 }]);
    });

    it("opens two boundaries for two sibling transactions", async () => {
        await handle(
            [echoRoute()],
            groupBody("batch", [
                { group: { kind: "transaction", calls: [callEntry("POST", "/echo", {})] } },
                { group: { kind: "transaction", calls: [callEntry("POST", "/echo", {})] } },
            ]),
        );

        expect(fake.boundaries).toEqual(["begin", "begin"]);
    });

    it("opens a nested transaction inside a batch as its own boundary", async () => {
        await handle(
            [echoRoute()],
            groupBody("batch", [
                callEntry("POST", "/echo", {}),
                { group: { kind: "transaction", calls: [callEntry("POST", "/echo", {})] } },
            ]),
        );

        expect(fake.boundaries).toEqual(["begin"]);
    });

    it("gives a handler that asks inside a transaction group a savepoint of its own", async () => {
        await handle(
            [echoRoute({ handler: async (executor) => await executor.transaction(async () => null) })],
            groupBody("transaction", [callEntry("POST", "/echo", {})]),
        );

        expect(fake.boundaries).toEqual(["begin", "savepoint 1"]);
    });

    it("opens the handler's own boundary inside a batch, which has none", async () => {
        await handle(
            [echoRoute({ handler: async (executor) => await executor.transaction(async () => null) })],
            groupBody("batch", [callEntry("POST", "/echo", {})]),
        );

        expect(fake.boundaries).toEqual(["begin"]);
    });

    it("reports an attempt's failure instead of failing the request", async () => {
        const response = await handle(
            [
                echoRoute({
                    path: "/inner",
                    handler: async () => {
                        throw Object.assign(new Error("version conflict"), { code: "40001" });
                    },
                }),
            ],
            groupBody("batch", [{ group: { kind: "attempt", calls: [callEntry("POST", "/inner", {})] } }]),
        );

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ ok: false, error: { message: "version conflict", path: [0, 0] } }]);
    });

    it("answers an attempt's success with its results", async () => {
        const response = await handle([echoRoute()], groupBody("attempt", [callEntry("POST", "/echo", { n: 1 })]));

        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual({ ok: true, value: [{ n: 1 }] });
    });

    it("gives an attempt a savepoint, so its failure leaves the outer group running", async () => {
        const response = await handle(
            [
                echoRoute(),
                echoRoute({
                    path: "/inner",
                    handler: async () => {
                        throw new Error("boom");
                    },
                }),
            ],
            groupBody("transaction", [
                callEntry("POST", "/echo", { first: true }),
                { group: { kind: "attempt", calls: [callEntry("POST", "/inner", {})] } },
                callEntry("POST", "/echo", { last: true }),
            ]),
        );

        expect(fake.boundaries).toEqual(["begin", "savepoint 1"]);
        expect(decode(response.body)).toEqual([
            { first: true },
            { ok: false, error: { message: "boom", path: [1, 0] } },
            { last: true },
        ]);
    });

    it("does not swallow a failure that is not its own", async () => {
        const response = await handle(
            [
                echoRoute({
                    handler: async () => {
                        throw new Error("outer boom");
                    },
                }),
            ],
            groupBody("transaction", [{ group: { kind: "attempt", calls: [callEntry("POST", "/echo", {})] } }]),
        );

        // The attempt caught it, so the request answers its marker rather than a failure.
        expect(response.status).toBe(200);
        expect(decode(response.body)).toEqual([{ ok: false, error: { message: "outer boom", path: [0, 0] } }]);
    });

    it("names the entry that failed by its path in the tree", async () => {
        const response = await handle(
            [
                echoRoute(),
                echoRoute({
                    path: "/inner",
                    handler: async () => {
                        throw Object.assign(new Error("version conflict"), { code: "40001" });
                    },
                }),
            ],
            groupBody("transaction", [
                callEntry("POST", "/echo", {}),
                { group: { kind: "batch", calls: [callEntry("POST", "/inner", {})] } },
            ]),
        );

        expect(response.status).toBe(409);
        expect(JSON.parse(response.body)).toEqual({ error: "version conflict", path: [1, 0] });
    });

    it("opens a transaction boundary with the modes the group named", async () => {
        await handle(
            [echoRoute()],
            groupBody(
                "transaction",
                [callEntry("POST", "/echo", {})],
                { isolationLevel: "serializable", accessMode: "read only" },
            ),
        );

        expect(fake.boundaries).toEqual(["begin"]);
        expect(fake.modes).toEqual([{ isolationLevel: "serializable", accessMode: "read only" }]);
    });

    it("opens an attempt boundary with them too", async () => {
        await handle(
            [echoRoute()],
            groupBody("attempt", [callEntry("POST", "/echo", {})], { deferrable: true }),
        );

        expect(fake.modes).toEqual([{ deferrable: true }]);
    });

    it("names no modes on a boundary the group left them off", async () => {
        await handle([echoRoute()], groupBody("transaction", [callEntry("POST", "/echo", {})]));

        expect(fake.modes).toEqual([undefined]);
    });

    it("gives a transaction inside a batch the modes it named, since it opens a root boundary there", async () => {
        await handle(
            [echoRoute()],
            groupBody("batch", [
                { group: { kind: "transaction", options: { accessMode: "read only" }, calls: [callEntry("POST", "/echo", {})] } },
            ]),
        );

        expect(fake.modes).toEqual([{ accessMode: "read only" }]);
    });

    it("refuses modes on a batch, which opens no boundary to put them on", async () => {
        const response = await handle(
            [echoRoute()],
            groupBody("batch", [callEntry("POST", "/echo", {})], { accessMode: "read only" }),
        );

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
            error: "a batch opens no boundary, so it takes no transaction options",
            path: [],
        });
    });

    it("refuses modes on a nested boundary, which is a savepoint and takes none", async () => {
        const response = await handle(
            [echoRoute()],
            groupBody("transaction", [
                { group: { kind: "transaction", options: { accessMode: "read only" }, calls: [] } },
            ]),
        );

        expect(response.status).toBe(400);
        expect(JSON.parse(response.body)).toEqual({
            error: "a nested boundary is a savepoint, which takes no transaction options",
            path: [0],
        });
    });

    it("refuses a mode that is not one the boundary can be opened with", async () => {
        const routes = [echoRoute()];
        const badLevel = await handle(
            routes,
            groupBody("transaction", [], { isolationLevel: "read uncommitted; drop table widget" }),
        );
        const badMode = await handle(routes, groupBody("transaction", [], { accessMode: "readonly" }));
        const badFlag = await handle(routes, groupBody("transaction", [], { deferrable: "yes" }));
        const badKey = await handle(routes, groupBody("transaction", [], { snapshot: "00000003-0000001B-1" }));

        expect(JSON.parse(badLevel.body)).toEqual({
            error: "an isolation level must be serializable, repeatable read, read committed, or read uncommitted",
            path: [],
        });
        expect(JSON.parse(badMode.body)).toEqual({ error: "an access mode must be read write, or read only", path: [] });
        expect(JSON.parse(badFlag.body)).toEqual({ error: "deferrable must be true or false", path: [] });
        expect(JSON.parse(badKey.body)).toEqual({
            error: "a transaction option must be isolationLevel, accessMode, or deferrable, not snapshot",
            path: [],
        });
        expect([badLevel.status, badMode.status, badFlag.status, badKey.status]).toEqual([400, 400, 400, 400]);
    });
});
