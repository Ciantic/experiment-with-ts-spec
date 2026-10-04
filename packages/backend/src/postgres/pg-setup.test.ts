/**
 * Asserts that `pg`'s pool reaches the port with no wrapper of its own, that `createPgPool` applies
 * the spec's result mapping, and that the driver's own types back the structural one. See
 * docs/transactions.md and docs/schema-generation.md.
 */
import * as realPg from "pg";
import { describe, expect, it } from "vitest";
import { createTransactionalDb, type SqlExecutor } from "../db/sql-executor.ts";
import type { SqlPool, SqlSession } from "../db/sql-pool.ts";
import { createPgMapperTypes, createPgPool, type PgMapperOptions, type PgModule, type PgPoolModule } from "./pg-setup.ts";

// `@types/pg` still describes `arrayParser` as the pre-v3 callable, while the runtime exports `{ create }`.
// Only that member needs the cast, so the rest of the structural fit is checked by assignment.
const pgModule: PgPoolModule = {
    Pool: realPg.Pool,
    types: {
        getTypeParser: realPg.types.getTypeParser,
        arrayParser: realPg.types.arrayParser as unknown as PgModule["types"]["arrayParser"],
    },
};

describe("a pg pool as the pool port", () => {
    it("satisfies `SqlPool`, so the wrapper the port used to need is gone", () => {
        const pool: SqlPool = new realPg.Pool();

        expect(typeof pool.connect).toBe("function");
    });

    it("checks out a client that satisfies `SqlSession`", () => {
        // The assignment is the assertion: `tsc` rejects a client that stops matching the session.
        const fitsCheckout: (client: realPg.PoolClient) => SqlSession = (client) => client;

        expect(fitsCheckout).toBeTypeOf("function");
    });

    it("builds the executor over a bare `Pool`, with no adapter in between", async () => {
        const pool = new realPg.Pool();
        const db: SqlExecutor = createTransactionalDb(pool);

        expect(typeof db.transaction).toBe("function");
        await pool.end();
    });
});

describe("createPgPool", () => {
    it("reads the runtime `arrayParser`, which the installed types still describe as a callable", () => {
        const arrayParser = (realPg.types as unknown as { arrayParser: { create?: unknown } }).arrayParser;

        expect(typeof arrayParser.create).toBe("function");
    });

    it("passes the driver's own config through", async () => {
        const pool = createPgPool(pgModule, { max: 7, application_name: "spec" });

        expect(pool.options.max).toBe(7);
        await pool.end();
    });

    it("applies the spec's mapping, so the results match the ports of the other driver", async () => {
        const pool = createPgPool(pgModule);
        const types: PgMapperOptions | undefined = pool.options.types;

        expect(types?.getTypeParser(20)("42")).toBe(42n);
        expect(types?.getTypeParser(1016)("{1,2}")).toEqual([1n, 2n]);
        expect(types?.getTypeParser(1114)("2026-01-04 12:00:00")).toBe("2026-01-04 12:00:00");
        expect(types?.getTypeParser(1082)("2026-01-04")).toBe("2026-01-04");
        expect(types?.getTypeParser(1700)("1.50")).toBe("1.50");
        expect(types?.getTypeParser(1182)("{2026-01-04}")).toEqual(["2026-01-04"]);
        expect(types?.getTypeParser(17)("\\x0102")).toEqual(new Uint8Array([1, 2]));
        await pool.end();
    });

    it("leaves an unmapped type to the driver", async () => {
        const pool = createPgPool(pgModule);

        // int4 is not remapped, so the mapper is the driver's own parser rather than a copy of it.
        expect(pool.options.types?.getTypeParser(23)("42")).toBe(42);
        await pool.end();
    });

    it("keeps its mapping even when the config names one, so a pool cannot silently lose the spec types", async () => {
        const pool = createPgPool(pgModule, { types: createPgMapperTypes(pgModule) });

        expect((pool.options.types as PgMapperOptions).getTypeParser(20)("42")).toBe(42n);
        await pool.end();
    });
});
