/** `pg` driver setup: result type mapping, pool construction, and the driver the app injects. Mirrors src/postgres/pglite-setup.ts. */
import type * as pgRuntime from "pg";
import { SqlDriver, type SqlConnection } from "../db/sql-driver.ts";
import type { QueryResult, SqlSubscription } from "../db/sql-executor.ts";

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
// oxlint-disable-next-line closures/factory-closure -- the parsers are pure and immutable
export function createPgMapperTypes(pg: typeof pgRuntime): PgMapperOptions {
    const textParser = (value: string) => value;
    const textArrayParser = (value: string) => (pg.types.arrayParser as any).create(value).parse();

    return {
        getTypeParser: (oid, format) => {
            // OIDs are from src/include/catalog/pg_type.dat.

            if (oid === INT8) {
                return (value: string) => BigInt(value);
            }
            if (oid === INT8_ARRAY) {
                return (value: string) =>
                    (pg.types.arrayParser as any)
                        .create(value)
                        .parse()
                        .map((item: any) => BigInt(String(item)));
            }
            if (oid === BYTEA) {
                const parser = pg.types.getTypeParser(oid, format);
                return (value: string) => new Uint8Array(parser(value) as ArrayLike<number>);
            }
            if (oid === BYTEA_ARRAY) {
                const parser = pg.types.getTypeParser(oid as any, format);
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

/** An SQL identifier, quoted so a channel name is not read as syntax. */
function quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
}

/** A `pg` driver as the app's driver: the mapped pool, a batch for the DDL, and shutdown. */
export class PgSqlDriver extends SqlDriver {
    readonly #pool: pgRuntime.Pool;

    constructor(pg: typeof pgRuntime, config: pgRuntime.PoolConfig = {}) {
        super();
        // The mapper's `types` wins over one the caller passes, so the pool cannot silently lose the spec types.
        this.#pool = new pg.Pool({ ...config, types: createPgMapperTypes(pg) });
    }

    async query<Row extends object = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<QueryResult<Row>> {
        const result = await this.#pool.query<Row>(sql, parameters);
        return { rows: result.rows, rowCount: result.rowCount };
    }

    protected async connect(): Promise<SqlConnection> {
        const client = await this.#pool.connect();
        return {
            query: async <Row extends object = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => {
                const result = await client.query<Row>(sql, parameters);
                return { rows: result.rows, rowCount: result.rowCount };
            },
            release: () => client.release(),
        };
    }

    async exec(sql: string): Promise<void> {
        await this.#pool.query(sql);
    }

    protected async listen(channel: string, onNotification: (payload: string) => void): Promise<SqlSubscription> {
        const client = await this.#pool.connect();
        const onNotice = (notice: { channel: string; payload?: string | undefined }) => {
            if (notice.channel === channel) {
                onNotification(notice.payload ?? "");
            }
        };
        try {
            client.on("notification", onNotice);
            await client.query(`listen ${quoteIdentifier(channel)}`);
        } catch (thrown) {
            client.removeListener("notification", onNotice);
            client.release();
            throw thrown;
        }
        let closed = false;
        return {
            close: async () => {
                if (closed) {
                    return;
                }
                closed = true;
                client.removeListener("notification", onNotice);
                try {
                    await client.query(`unlisten ${quoteIdentifier(channel)}`);
                } finally {
                    client.release();
                }
            },
        };
    }

    protected async shutdown(): Promise<void> {
        await this.#pool.end();
    }
}
