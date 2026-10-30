/** PGlite configuration, result type mapping, and the driver the app injects. See docs/schema-generation.md. */
import type { DebugLevel, PGlite, ParserOptions } from "@electric-sql/pglite";
import { SqlDriver, type SqlSession } from "../db/sql-driver.ts";

/** Postgres type OIDs, from src/include/catalog/pg_type.dat. */
const OID = {
    int8: 20,
    timestamp: 1114,
    date: 1082,
} as const;

/** Result parsers ported from https://github.com/Ciantic/pg-unified-mapping. */
export function createPgliteParsers(): ParserOptions {
    return {
        [OID.int8]: (value: string) => BigInt(value),
        [OID.timestamp]: (value: string) => value,
        [OID.date]: (value: string) => value,
    };
}

/** The PGlite class, taken as a parameter so the package stays a development dependency of infra. */
export type PgliteConstructor = typeof PGlite;

/** A PGlite driver whose results match the spec types, over the one connection it opens. `debug` is PGlite's own log level. */
export class PgliteSqlDriver extends SqlDriver {
    readonly #pglite: PGlite;
    #turn: Promise<void> = Promise.resolve();

    constructor(Pglite: PgliteConstructor, options: { debug?: DebugLevel } = {}) {
        super();
        this.#pglite = new Pglite({ parsers: createPgliteParsers(), debug: options.debug ?? 0 });
    }

    /** Wait for the current turn, then hold the connection until the session is released. */
    async #take(): Promise<SqlSession> {
        const previous = this.#turn;
        let handOff!: () => void;
        this.#turn = new Promise<void>((resolve) => {
            handOff = resolve;
        });
        await previous;
        let released = false;
        return {
            query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => {
                const result = await this.#pglite.query<Row>(sql, parameters);
                return { rows: result.rows, affectedRows: result.affectedRows ?? 0 };
            },
            release: () => {
                if (released) {
                    return;
                }
                released = true;
                handOff();
            },
        };
    }

    // A plain statement takes the same turn, so it cannot slip inside an open boundary.
    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }> {
        const session = await this.#take();
        try {
            return await session.query<Row>(sql, parameters);
        } finally {
            session.release();
        }
    }

    connect(): Promise<SqlSession> {
        return this.#take();
    }

    exec(sql: string): Promise<unknown> {
        return this.#pglite.exec(sql);
    }

    close(): Promise<void> {
        return this.#pglite.close();
    }
}
