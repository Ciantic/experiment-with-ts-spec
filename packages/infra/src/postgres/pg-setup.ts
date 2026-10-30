/** `pg` driver setup: result type mapping, pool construction, and the driver the app injects. Mirrors src/postgres/pglite-setup.ts. */
import type { Pool, PoolConfig } from "pg";
import { SqlDriver, type SqlSession } from "../db/sql-driver.ts";

/** The subset of the `pg` module the mapper needs, taken as a parameter so `pg` stays an optional dependency. */
export interface PgModule {
    types: {
        getTypeParser: (oid: number, format?: "text" | "binary") => (value: string) => unknown;
        arrayParser: {
            create: (source: string, transform?: unknown) => { parse: () => unknown[] };
        };
    };
}

/** Passed to `new pg.Client({ types: ... })` or `new pg.Pool({ types: ... })`. */
export interface PgMapperOptions {
    getTypeParser: (oid: number, format?: "text" | "binary") => (value: string) => unknown;
}

/** Types whose default parser loses information, returned as raw text instead. */
const TEXT_TYPES = new Set([
    628, // line
    600, // point
    718, // circle
    1082, // date
    1114, // timestamp
    1186, // interval
    1700, // numeric
    601, // lseg
    602, // path
    774, // macaddr8
    3614, // tsvector
    3615, // tsquery
    604, // polygon
]);

/** Array forms of TEXT_TYPES, which have their own OIDs. */
const TEXT_ARRAY_TYPES = new Set([
    629, 1017, 719, 1182, 1115, 1187, 1231, 1018, 1019, 775, 3643, 3645, 1027, 3221, 5039, 1561, 1563, 143,
]);

const INT8 = 20;
const INT8_ARRAY = 1016;
const BYTEA = 17;
const BYTEA_ARRAY = 1001;

/** PostgreSQL result parsers, ported from https://github.com/Ciantic/pg-unified-mapping. */
export function createPgMapperTypes(pg: PgModule): PgMapperOptions {
    const textParser = (value: string) => value;
    const textArrayParser = (value: string) => pg.types.arrayParser.create(value).parse();

    return {
        getTypeParser: (oid, format) => {
            // OIDs are from src/include/catalog/pg_type.dat.

            if (oid === INT8) {
                return (value: string) => BigInt(value);
            }
            if (oid === INT8_ARRAY) {
                return (value: string) =>
                    pg.types.arrayParser
                        .create(value)
                        .parse()
                        .map((item) => BigInt(String(item)));
            }
            if (oid === BYTEA) {
                const parser = pg.types.getTypeParser(oid, format);
                return (value: string) => new Uint8Array(parser(value) as ArrayLike<number>);
            }
            if (oid === BYTEA_ARRAY) {
                const parser = pg.types.getTypeParser(oid, format);
                return (value: string) =>
                    (parser(value) as unknown[]).map((item) => new Uint8Array(item as ArrayLike<number>));
            }
            if (TEXT_TYPES.has(oid)) {
                return textParser;
            }
            if (TEXT_ARRAY_TYPES.has(oid)) {
                return textArrayParser;
            }

            return pg.types.getTypeParser(oid, format);
        },
    };
}

/** The `pg` module as pool construction needs it: the `Pool` class, plus the parser surface the mapper reads. */
export interface PgPoolModule extends PgModule {
    Pool: new (config: PoolConfig) => Pool;
}

/** The rows a `pg` result says the statement wrote; a row-returning statement wrote none. */
function writtenRows(result: { command?: string; rowCount: number | null }): number {
    return result.command === "SELECT" ? 0 : result.rowCount ?? 0;
}

/** A `pg` driver as the app's driver: the mapped pool, a batch for the DDL, and shutdown. */
export class PgSqlDriver extends SqlDriver {
    readonly #pool: Pool;

    constructor(pg: PgPoolModule, config: PoolConfig = {}) {
        super();
        // The mapper's `types` wins over one the caller passes, so the pool cannot silently lose the spec types.
        this.#pool = new pg.Pool({ ...config, types: createPgMapperTypes(pg) });
    }

    async query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }> {
        const result = await this.#pool.query<Row>(sql, parameters);
        return { rows: result.rows, affectedRows: writtenRows(result) };
    }

    async connect(): Promise<SqlSession> {
        const client = await this.#pool.connect();
        return {
            query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => {
                const result = await client.query<Row>(sql, parameters);
                return { rows: result.rows, affectedRows: writtenRows(result) };
            },
            release: () => client.release(),
        };
    }

    exec(sql: string): Promise<unknown> {
        return this.#pool.query(sql);
    }

    async close(): Promise<void> {
        await this.#pool.end();
    }
}
