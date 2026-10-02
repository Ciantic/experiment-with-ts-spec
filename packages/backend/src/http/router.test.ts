/** Unit tests for the hand-written router, over fixture routes. See docs/testing.md. */
import { parse as decode, stringify } from "devalue";
import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { createRouter, type Route, type RouteInput } from "./router.ts";

/** A schema stand-in that accepts any argument; the router test is not about Zod. */
const accepts: RouteInput = {
    safeParse: (value) => ({ success: true, data: value }),
};

/** A schema stand-in that always rejects, so the failure path is exercised without Zod. */
const rejects: RouteInput = {
    safeParse: () => ({ success: false, error: { issues: ["bad"] } }),
};

const db: SqlExecutor = { query: async () => ({ rows: [] }) };

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

    it("hands the handler the db it was built with", async () => {
        const seen: SqlExecutor[] = [];
        const route = echoRoute({
            handler: async (executor) => {
                seen.push(executor);
                return null;
            },
        });
        const router = createRouter(db, [route]);

        await router.handle({ method: "POST", url: "/echo", body: "" });

        expect(seen).toEqual([db]);
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
});
