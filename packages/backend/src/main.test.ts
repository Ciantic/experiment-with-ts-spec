/** End-to-end smoke test: the generated client talks to a live server. See docs/testing.md and docs/mockdata.md. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import * as api from "sdk/api/index.ts";
import { AppError, createHttpClient, exec, transactionWith, ValidationError, call, NotFoundError } from "sdk/index.ts";
import type { Call, Executable, HttpClient } from "sdk/index.ts";
import { mockTables } from "spec/mockdata/index.ts";
import { createAppContext } from "./context.ts";
import { routes } from "./http/routes/index.ts";
import { parseArgs, startServer, type StartedServer } from "./main.ts";

/** A generated builder, as this test sees it: pure data, so calling one makes no request. */
type Builder = (argument: unknown) => Call<unknown>;

/** The prefixes the generator gives its builders. Narrow, so no hand-written export is probed. */
const GENERATED = /^(?:query|create|upsert|update|delete)[A-Z]/;

/** The hand-written exports; probing `createHttpClient` would call it, as it shares the `create` prefix. */
const HAND_WRITTEN = new Set([
    "createHttpClient",
    "exec",
    "transaction",
    "transactionWith",
    "attempt",
    "attemptWith",
    "batch",
]);

/** Every generated builder in the barrel, picked by name and confirmed by shape. */
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

/** The filter a read of `entity` names, derived from the rows: their identity plus any tenant. */
function readFilter(entity: string): Record<string, unknown> {
    const rows = (mockTables.find((table) => table.entity === entity)?.rows ?? []) as Record<string, unknown>[];
    const fields = ["id", "tenantId"].filter((field) => rows[0]?.[field] !== undefined);

    return Object.fromEntries(fields.map((field) => [field, rows.map((row) => row[field])]));
}

let started!: StartedServer;
let http!: HttpClient;

beforeAll(async () => {
    started = await startServer({ port: 0, seed: true });
    http = createHttpClient(`http://127.0.0.1:${started.port}`);
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
    });
    await started.db.close();
});

describe("the generated client and the generated route table", () => {
    it("agree on every call, so no builder can reach a route or name an id the server does not serve", () => {
        const served = new Map(routes.map((route) => [`${route.method} ${route.path}`, route.id]));

        // A builder is inert, so this needs no server: the call carries its own verb, path, and operation.
        for (const [name, builder] of builders()) {
            const { operation, method, path } = builder(undefined);

            expect(served.has(`${method} ${path}`), `${name} reaches ${method} ${path}`).toBe(true);
            expect(served.get(`${method} ${path}`), `${name} names ${operation}`).toBe(operation);
        }
    });

    it("expose at least one call, so the assertion above is not vacuous", () => {
        expect(builders().length).toBeGreaterThan(0);
    });
});

describe("the operation routes", () => {
    /** Every id the server answers, which includes the calls `@restOperation` declares. */
    function operationIds(): string[] {
        const entityIds = new Set(mockTables.map((table) => table.entity));
        const prefixes = /^(?:query|create|upsert|update|delete)[A-Z]/;
        return routes
            .map((route) => route.id)
            .filter((id) => !prefixes.test(id) && !entityIds.has(id));
    }

    it("expose a client builder that names the served verb and path", () => {
        const barrel = api as unknown as Record<string, Builder | undefined>;
        const ids = operationIds();
        expect(ids.length).toBeGreaterThan(0);

        for (const id of ids) {
            const builder = barrel[id];
            expect(builder, id).toBeTypeOf("function");
            const built = builder!(undefined);
            const route = routes.find((candidate) => candidate.id === id);
            expect(built).toMatchObject({ kind: "call", operation: id, method: route?.method, path: route?.path });
        }
    });

    it("answer a refused argument with a 400, so the route is wired to a schema", async () => {
        for (const id of operationIds()) {
            const route = routes.find((candidate) => candidate.id === id)!;
            const thrown = await exec(http, call(id, route.method, route.path, "not an input")).catch(
                (error: unknown) => error,
            );

            expect(thrown, id).toBeInstanceOf(ValidationError);
            expect(thrown).not.toBeInstanceOf(NotFoundError);
        }
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

            const result = await exec(
                http,
                query!({ filter: readFilter(entity), select: {} }) as Executable<unknown[]>,
            );

            expect(result, entity).toHaveLength(rows.length);
        }
    });
});

describe("a live server", () => {
    it("answers every generated query with an array", async () => {
        for (const [name, builder] of buildersNamed("query")) {
            const filter = readFilter(name.slice("query".length));
            const result = await exec(http, builder({ filter, select: {} }) as Executable<unknown[]>);

            expect(Array.isArray(result), name).toBe(true);
        }
    });

    it("claims a route for every write, so a malformed one is a 400 and not a 404", async () => {
        for (const [name, builder] of builders().filter(([name]) => !name.startsWith("query"))) {
            const thrown = await exec(http, builder("not a write") as Executable<never>).catch(
                (error: unknown) => error,
            );

            expect(thrown, name).toBeInstanceOf(ValidationError);
            expect((thrown as AppError).status, name).toBe(400);
            expect((thrown as AppError).kind, name).toBe("validation");
        }
    });

    it("reaches an upsert through PUT, the verb a whole-row replacement means", async () => {
        const upserts = buildersNamed("upsert");

        // Without this the generic write assertions would pass by covering no upsert at all.
        expect(upserts.length).toBeGreaterThan(0);

        for (const [name, builder] of upserts) {
            const { method, path } = builder(undefined);

            expect(method, name).toBe("PUT");
            expect(path, name).toBeTruthy();
        }
    });

    it("carries a value JSON cannot, so the body codec is exercised end to end", async () => {
        // A write is refused for its shape rather than for its encoding, so a Date survives the body.
        const [name, builder] = builders().find(([name]) => name.startsWith("create"))!;

        const thrown = (await exec(http, builder([{ at: new Date(0) }]) as Executable<never>).catch(
            (error: unknown) => error,
        )) as AppError;

        expect(name).toMatch(GENERATED);
        expect(thrown).toBeInstanceOf(ValidationError);
        expect(thrown.status).toBe(400);
    });

    it("runs a group with the modes it names, so both hand-written halves agree on them", async () => {
        const first = buildersNamed("query")[0];
        expect(first, "a generated query is needed to group").toBeDefined();
        const [, builder] = first!;

        const result = await exec(
            http,
            transactionWith(
                { isolationLevel: "serializable", accessMode: "read only" },
                builder({ select: {} }),
            ),
        );

        expect(Array.isArray(result)).toBe(true);
    });
});

describe("--log-sql", () => {
    /** Everything `run` prints to `console.log`. */
    async function capture(run: () => Promise<void>): Promise<string[]> {
        const printed: string[] = [];
        const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
            printed.push(args.map(String).join(" "));
        });
        try {
            await run();
        } finally {
            log.mockRestore();
        }
        return printed;
    }

    it("is the only thing that turns statement logging on", () => {
        expect(parseArgs([]).logSql).toBeUndefined();
        expect(parseArgs(["--log-sql"]).logSql).toBe(true);
    });

    it("shows both what the server runs and the boundaries the executor issues", async () => {
        const printed = await capture(async () => {
            const app = await createAppContext({ logSql: true });
            await app.database.query("select 1 as one");
            await app.database.transaction((tx) => tx.query("select 2 as two"));
            await app.database.close();
        });

        expect(printed.some((line) => line.includes("select 1 as one"))).toBe(true);
        expect(printed.some((line) => line.includes("select 2 as two"))).toBe(true);
        expect(printed.some((line) => line.includes("begin"))).toBe(true);
        expect(printed.some((line) => line.includes("commit"))).toBe(true);
    });

    it("stays quiet without the flag, so an ordinary run prints no SQL", async () => {
        const printed = await capture(async () => {
            const app = await createAppContext();
            await app.database.query("select 3 as three");
            await app.database.close();
        });

        expect(printed.some((line) => line.includes("select 3 as three"))).toBe(false);
    });
});
