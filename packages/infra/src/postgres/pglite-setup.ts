/** PGlite configuration, result type mapping, and the driver the app injects. See docs/schema-generation.md. */
import type { DebugLevel, PGlite, ParserOptions } from "@electric-sql/pglite";
import { SqlDriver, type SqlConnection } from "../db/sql-driver.ts";
import type { QueryResult, SqlSubscription } from "../db/sql-executor.ts";

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

/** How the driver opens its database. */
export interface PgliteDriverOptions {
    /** The directory PGlite stores its files in; absent keeps the database in memory. */
    dataDir?: string;
    /** PGlite's own log level. */
    debug?: DebugLevel;
}

/** A PGlite driver whose results match the spec types, over the one connection it opens; `dataDir` persists it to files. */
export class PgliteSqlDriver extends SqlDriver {
    readonly #pglite: PGlite;
    #turn: Promise<void> = Promise.resolve();

    constructor(Pglite: PgliteConstructor, options: PgliteDriverOptions = {}) {
        super();
        const config = { parsers: createPgliteParsers(), debug: options.debug ?? 0 };
        // PGlite reads its options from the first argument when there is no dataDir, so an in-memory database passes only them.
        this.#pglite = options.dataDir === undefined ? new Pglite(config) : new Pglite(options.dataDir, config);
    }

    /** Wait for the current turn, then hold the connection until it is released. */
    async #take(): Promise<SqlConnection> {
        const previous = this.#turn;
        let handOff!: () => void;
        this.#turn = new Promise<void>((resolve) => {
            handOff = resolve;
        });
        await previous;
        let released = false;
        return {
            query: async <Row extends object = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => {
                const result = await this.#pglite.query<Row>(sql, parameters);
                return { rows: result.rows, rowCount: result.rowCount ?? null };
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

    /** Run on the one connection while it is held, so nothing interleaves with an open boundary. */
    async #exclusive<T>(run: (connection: SqlConnection) => Promise<T>): Promise<T> {
        const connection = await this.#take();
        try {
            return await run(connection);
        } finally {
            connection.release();
        }
    }

    // A plain statement takes the same turn, so it cannot slip inside an open boundary.
    async query<Row extends object = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<QueryResult<Row>> {
        return await this.#exclusive((connection) => connection.query<Row>(sql, parameters));
    }

    protected connect(): Promise<SqlConnection> {
        return this.#take();
    }

    // The DDL batch takes the same turn as a statement, so it cannot run inside an open boundary.
    async exec(sql: string): Promise<void> {
        await this.#exclusive(async () => {
            await this.#pglite.exec(sql);
        });
    }

    protected async listen(channel: string, onNotification: (payload: string) => void): Promise<SqlSubscription> {
        return await this.#exclusive(async () => {
            const close = await this.#pglite.listen(channel, (payload) => onNotification(payload));
            return {
                close: async () => {
                    await this.#exclusive(async () => {
                        await close();
                    });
                },
            };
        });
    }

    protected shutdown(): Promise<void> {
        return this.#pglite.close();
    }
}
