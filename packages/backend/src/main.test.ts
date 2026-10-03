/**
 * End-to-end smoke test: the generated client talks to a live server. See
 * docs/testing.md and docs/mockdata.md.
 *
 * The round-trip below is driven by the generated artifacts and the seed data
 * rather than by named entities, so a domain change does not rewrite this file:
 * it walks whatever `mockTables` lists and asserts each query answers with the
 * number of rows that were seeded. That one import is seed *data*, not the domain
 * model — renaming or adding a field leaves every assertion here untouched.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as api from "sdk/index.ts";
import type { Call, Executable, HttpClient } from "sdk/index.ts";
import { mockTables } from "spec/mockdata/index.ts";
import { routes } from "./http/routes.ts";
import { startServer, type StartedServer } from "./main.ts";

/** A generated builder, as this test sees it: pure data, so calling one makes no request. */
type Builder = (argument: unknown) => Call<unknown>;

/** The prefixes the generator gives its builders. Narrow, so no hand-written export is probed. */
const GENERATED = /^(?:query|create|update|delete)[A-Z]/;

/**
 * The exports that are hand-written rather than generated. `createHttpClient`
 * shares the generator's `create` prefix, and probing it would call it.
 */
const HAND_WRITTEN = new Set(["createHttpClient", "exec", "transaction", "attempt", "batch", "bundle", "toWire"]);

/**
 * Every generated call builder in the client barrel. Verified by shape as well as
 * by name: a builder answers a `Call`.
 */
function builders(): [string, Builder][] {
    const barrel = api as unknown as Record<string, unknown>;
    return Object.entries(barrel).flatMap(([name, value]) => {
        if (typeof value !== "function" || !GENERATED.test(name) || HAND_WRITTEN.has(name)) {
            return [];
        }
        // A builder binds no client and touches no I/O, so probing one is safe.
        const probe = (value as Builder)(undefined) as { kind?: unknown };
        return probe?.kind === "call" ? [[name, value as Builder]] : [];
    });
}

/** Every builder whose name starts with `prefix`. */
function buildersNamed(prefix: string): [string, Builder][] {
    return builders().filter(([name]) => name.startsWith(prefix));
}

let started!: StartedServer;
let http!: HttpClient;

beforeAll(async () => {
    started = await startServer({ port: 0, seed: true });
    http = api.createHttpClient(`http://127.0.0.1:${started.port}`);
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
    });
    await started.db.close();
});

describe("the generated client and the generated route table", () => {
    it("agree on every call, so no builder can reach a path the server does not serve", () => {
        const served = new Set(routes.map((route) => `${route.method} ${route.path}`));

        // A builder is inert, so this needs no server: the call carries its own method and path.
        for (const [name, builder] of builders()) {
            const { method, path } = builder(undefined);

            expect(served.has(`${method} ${path}`), `${name} reaches ${method} ${path}`).toBe(true);
        }
    });

    it("expose at least one call, so the assertion above is not vacuous", () => {
        expect(builders().length).toBeGreaterThan(0);
    });
});

describe("seeded server", () => {
    it("round-trips every mock table through its generated client call", async () => {
        const calls = api as unknown as Record<string, Builder | undefined>;

        // Without this the loop below would pass by never running.
        expect(mockTables.length).toBeGreaterThan(0);

        for (const { entity, rows } of mockTables) {
            const query = calls[`query${entity}`];
            expect(query, `query${entity} is generated`).toBeTypeOf("function");

            const result = await api.exec(http, query!({ select: {} }) as Executable<unknown[]>);

            expect(result, entity).toHaveLength(rows.length);
        }
    });
});

describe("a live server", () => {
    it("answers every generated query with an array", async () => {
        for (const [name, builder] of buildersNamed("query")) {
            const result = await api.exec(http, builder({ select: {} }) as Executable<unknown[]>);

            expect(Array.isArray(result), name).toBe(true);
        }
    });

    it("claims a route for every write, so a malformed one is a 400 and not a 404", async () => {
        for (const [name, builder] of builders().filter(([name]) => !name.startsWith("query"))) {
            const thrown = (await api.exec(http, builder("not a write") as Executable<never>).catch(
                (error: unknown) => error,
            )) as { status?: number };

            expect(thrown.status, name).toBe(400);
        }
    });

    it("carries a value JSON cannot, so the body codec is exercised end to end", async () => {
        // A write is refused for its shape rather than for its encoding, so a Date survives the body.
        const [name, builder] = builders().find(([name]) => name.startsWith("create"))!;

        const thrown = (await api.exec(http, builder([{ at: new Date(0) }]) as Executable<never>).catch(
            (error: unknown) => error,
        )) as { status?: number };

        expect(name).toMatch(GENERATED);
        expect(thrown.status).toBe(400);
    });
});
