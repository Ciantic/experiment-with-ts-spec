/** Asserts the pg driver applies the spec's result mapping and matches the structural types. See docs/schema-generation.md. */
import * as realPg from "pg";
import type { PoolConfig } from "pg";
import { describe, expect, it } from "vitest";
import type { SqlExecutor } from "../db/sql-executor.ts";
import type { SqlDriver } from "../db/sql-driver.ts";
import { createPgMapperTypes, PgSqlDriver, type PgModule, type PgPoolModule } from "./pg-setup.ts";

// `@types/pg` describes the pre-v3 `arrayParser`; only that member needs a cast, and the rest fits by assignment.
const pgModule: PgPoolModule = {
    Pool: realPg.Pool,
    types: {
        getTypeParser: realPg.types.getTypeParser,
        arrayParser: realPg.types.arrayParser as unknown as PgModule["types"]["arrayParser"],
    },
};

/** A `Pool` stand-in that records the config the driver constructs it with. */
function recordingModule(): { module: PgPoolModule; config: () => PoolConfig } {
    let received: PoolConfig = {};
    class RecordingPool {
        constructor(config: PoolConfig = {}) {
            received = config;
        }
        query() {
            return Promise.resolve({ rows: [] });
        }
        connect() {
            return Promise.resolve({ query: () => Promise.resolve({ rows: [] }), release: () => {} });
        }
        end() {
            return Promise.resolve();
        }
    }
    return {
        module: { ...pgModule, Pool: RecordingPool as unknown as PgPoolModule["Pool"] },
        config: () => received,
    };
}

describe("a pg driver as the transaction port", () => {
    it("checks out a client that fits `connect`", () => {
        // The assignment is the assertion: `tsc` rejects a client that stops matching the session.
        type Session = Awaited<ReturnType<SqlDriver["connect"]>>;
        const fitsCheckout: (client: realPg.PoolClient) => Session = (client) => client;

        expect(fitsCheckout).toBeTypeOf("function");
    });

    it("builds the executor over the driver", async () => {
        const driver = new PgSqlDriver(pgModule);
        const db: SqlExecutor = driver.createExecutor();

        expect(typeof db.transaction).toBe("function");
        await driver.close();
    });
});

describe("createPgMapperTypes", () => {
    it("maps the spec's types, so the results match the other driver", () => {
        const types = createPgMapperTypes(pgModule);

        expect(types.getTypeParser(20)("42")).toBe(42n);
        expect(types.getTypeParser(1016)("{1,2}")).toEqual([1n, 2n]);
        expect(types.getTypeParser(1114)("2026-01-04 12:00:00")).toBe("2026-01-04 12:00:00");
        expect(types.getTypeParser(1082)("2026-01-04")).toBe("2026-01-04");
        expect(types.getTypeParser(1700)("1.50")).toBe("1.50");
        expect(types.getTypeParser(1182)("{2026-01-04}")).toEqual(["2026-01-04"]);
        expect(types.getTypeParser(17)("\\x0102")).toEqual(new Uint8Array([1, 2]));
    });

    it("leaves an unmapped type to the driver", () => {
        const types = createPgMapperTypes(pgModule);

        // int4 is not remapped, so the mapper is the driver's own parser rather than a copy of it.
        expect(types.getTypeParser(23)("42")).toBe(42);
    });

    it("reads the runtime `arrayParser`, which the installed types still describe as a callable", () => {
        const arrayParser = (realPg.types as unknown as { arrayParser: { create?: unknown } }).arrayParser;

        expect(typeof arrayParser.create).toBe("function");
    });
});

describe("PgSqlDriver", () => {
    it("passes the driver's own config through when it builds the pool", () => {
        const { module, config } = recordingModule();

        new PgSqlDriver(module, { max: 7, application_name: "spec" });

        expect(config().max).toBe(7);
        expect(config().application_name).toBe("spec");
    });

    it("keeps its mapping even when the config names one, so a driver cannot silently lose the spec types", () => {
        const { module, config } = recordingModule();

        new PgSqlDriver(module, { types: { getTypeParser: () => () => "overridden" } });

        expect(config().types?.getTypeParser(20)("42")).toBe(42n);
    });

    it("maps pg's rowCount into affectedRows on the pool and on a checkout", async () => {
        class CountingPool {
            async query(sql: string) {
                return sql.startsWith("select")
                    ? { command: "SELECT", rows: [{ id: "pool" }], rowCount: 1 }
                    : { command: "UPDATE", rows: [{ id: "pool" }], rowCount: 2 };
            }
            async connect() {
                return {
                    query: async (sql: string) =>
                        sql.startsWith("select")
                            ? { command: "SELECT", rows: [{ id: "session" }], rowCount: 1 }
                            : { command: "UPDATE", rows: [{ id: "session" }], rowCount: 3 },
                    release: () => {},
                };
            }
            async end() {
                return;
            }
        }
        const module = { ...pgModule, Pool: CountingPool as unknown as PgPoolModule["Pool"] };
        const driver = new PgSqlDriver(module);

        expect(await driver.query("select 1")).toEqual({ rows: [{ id: "pool" }], affectedRows: 0 });
        expect(await driver.query("update widget set id = id")).toEqual({ rows: [{ id: "pool" }], affectedRows: 2 });

        const session = await driver.connect();
        expect(await session.query("select 1")).toEqual({ rows: [{ id: "session" }], affectedRows: 0 });
        expect(await session.query("update widget set id = id")).toEqual({
            rows: [{ id: "session" }],
            affectedRows: 3,
        });
        session.release();
        await driver.close();
    });

    it("builds the statement, checkout, batch, and shutdown surface over the mapped pool", async () => {
        const driver = new PgSqlDriver(pgModule);

        expect(typeof driver.query).toBe("function");
        expect(typeof driver.connect).toBe("function");
        expect(typeof driver.exec).toBe("function");
        await driver.close();
    });
});
