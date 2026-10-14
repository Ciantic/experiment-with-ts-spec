/** Unit tests for the Hono app over fixture routes. See docs/testing.md. */
import { parse as decode, stringify } from "devalue";
import { beforeEach, describe, expect, it } from "vitest";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { createApiApp } from "./app.ts";
import { GROUP_PATH } from "./group-handler.ts";
import type { Route, RouteInput } from "./route.ts";

/** A schema stand-in that accepts any argument; the app test is not about Zod. */
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
        id: "echo",
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

/** An app over a fixture table. */
function app(table: Route[]) {
    return createApiApp(db, table);
}

/** One request, sent the way the transport sends it. */
async function request(table: Route[], method: string, url: string, body?: string): Promise<Response> {
    return await app(table).request(url, { method, ...(body === undefined ? {} : { body }) });
}

/** The body of a successful response: `devalue` text. */
async function read(response: Response): Promise<unknown> {
    return decode(await response.text());
}

/** The body of a failure: plain JSON, readable without the codec. */
async function readError(response: Response): Promise<unknown> {
    return JSON.parse(await response.text());
}

/** `/echo` with the argument devalue-encoded into `q`, as the client sends it. */
function queryUrl(argument: unknown): string {
    return `/echo?q=${encodeURIComponent(stringify(argument))}`;
}

/** A value with both of the types a JSON encoding would lose. */
const payload = { at: new Date("2026-01-02T03:04:05.000Z"), revision: 7n, name: "widget" };

describe("createApiApp", () => {
    it("answers 404 for a call the table does not expose", async () => {
        const response = await request([echoRoute()], "POST", "/missing", "");

        expect(response.status).toBe(404);
        expect(await readError(response)).toEqual({ error: "no route" });
    });

    it("matches on the method as well as the path", async () => {
        const response = await request([echoRoute()], "PATCH", "/echo");

        expect(response.status).toBe(404);
    });

    it("serves a PUT, the verb an upsert reaches the server with", async () => {
        const response = await request([echoRoute({ method: "PUT" })], "PUT", "/echo", stringify(payload));

        expect(response.status).toBe(200);
        expect(await read(response)).toEqual(payload);
    });

    it("answers 400 for a body that is not decodable", async () => {
        const response = await request([echoRoute()], "POST", "/echo", "not devalue");

        expect(response.status).toBe(400);
        expect(await readError(response)).toEqual({ error: "malformed request" });
    });

    it("answers 400 with the issues when the schema rejects", async () => {
        const response = await request([echoRoute({ input: rejects })], "POST", "/echo", "");

        expect(response.status).toBe(400);
        expect(await readError(response)).toEqual({ error: "invalid request", issues: ["bad"] });
    });

    it("passes the decoded body to the handler and encodes the result", async () => {
        const response = await request([echoRoute()], "POST", "/echo", stringify(payload));

        expect(response.status).toBe(200);
        expect(await read(response)).toEqual(payload);
    });

    it("decodes the query parameter for a call that carries its argument there", async () => {
        const response = await request([queryRoute()], "GET", queryUrl(payload));

        expect(response.status).toBe(200);
        expect(await read(response)).toEqual(payload);
    });

    it("reads a body call's argument from where the route says, ignoring the query string", async () => {
        const response = await request(
            [echoRoute()],
            "POST",
            queryUrl({ from: "query" }),
            stringify({ from: "body" }),
        );

        expect(await read(response)).toEqual({ from: "body" });
    });

    it("answers 400 for a query parameter that is not decodable", async () => {
        const response = await request([queryRoute()], "GET", "/echo?q=not%20devalue");

        expect(response.status).toBe(400);
        expect(await readError(response)).toEqual({ error: "malformed request" });
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

        const response = await request([route], "GET", "/echo");

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
        db.query = async (sql) => {
            statements.push(sql);
            return { rows: [] };
        };

        await request([route], "POST", "/echo");

        expect(statements).toEqual(["select 1"]);
    });

    it("encodes an undefined result as null", async () => {
        const response = await request([echoRoute({ handler: async () => undefined })], "POST", "/echo");

        expect(response.status).toBe(200);
        expect(await read(response)).toBeNull();
    });

    it("maps the version conflict to 409", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("version conflict"), { code: "40001" });
            },
        });

        const response = await request([route], "POST", "/echo");

        expect(response.status).toBe(409);
        expect(await readError(response)).toEqual({ error: "version conflict" });
    });

    it("maps a unique violation to 409 and an unknown failure to 500", async () => {
        const violating = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("duplicate"), { code: "23505" });
            },
        });
        const broken = echoRoute({
            handler: async () => {
                throw new Error("boom");
            },
        });

        expect((await request([violating], "POST", "/echo")).status).toBe(409);
        expect((await request([broken], "POST", "/echo")).status).toBe(500);
    });

    it("maps a check violation to 400", async () => {
        const route = echoRoute({
            handler: async () => {
                throw Object.assign(new Error("value rejected by a row constraint"), { code: "23514" });
            },
        });

        const response = await request([route], "POST", "/echo");

        expect(response.status).toBe(400);
        expect(await readError(response)).toEqual({ error: "value rejected by a row constraint" });
    });

    it("opens a boundary when a handler asks for one, and no other", async () => {
        const route = echoRoute({
            handler: async (executor) => await executor.transaction(async () => null),
        });

        await request([route], "POST", "/echo");

        expect(fake.boundaries).toEqual(["begin"]);
    });

    it("refuses a body larger than the cap", async () => {
        const response = await request([echoRoute()], "POST", "/echo", `"${"x".repeat(1_000_000)}"`);

        expect(response.status).toBe(400);
        expect(await readError(response)).toEqual({ error: "request body too large" });
    });

    it("serves the group path, resolving each entry by its operation id", async () => {
        const body = stringify({
            group: { kind: "batch", calls: [{ call: { operation: "echo", argument: { n: 1 } } }] },
        });

        const response = await request([echoRoute()], "POST", GROUP_PATH, body);

        expect(response.status).toBe(200);
        expect(await read(response)).toEqual([{ n: 1 }]);
    });

    it("answers 400 for a group entry that names an operation it does not serve", async () => {
        const body = stringify({
            group: { kind: "batch", calls: [{ call: { operation: "nope", argument: {} } }] },
        });

        const response = await request([echoRoute()], "POST", GROUP_PATH, body);

        expect(response.status).toBe(400);
        expect(await readError(response)).toEqual({ error: "no operation `nope`", path: [0] });
    });
});
