/** The driver port, and the one-connection adapter a single-session driver reaches it through. See docs/transactions.md. */

/** The session a boundary is pinned to: statements, and the release that hands the connection on. */
export interface SqlSession {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }>;
    release(): void;
}

/** The process's driver: statements, checkouts, the DDL batch, and shutdown. */
export interface SqlDriver {
    /** Run one statement; the connection is not pinned across calls, so two may land on different ones. */
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }>;
    /** Pin one connection to the returned session until it is released. */
    connect(): Promise<SqlSession>;
    /** Run a batch of statements, the generated DDL included. */
    exec(sql: string): Promise<unknown>;
    /** Release the driver's resources. */
    close(): Promise<void>;
}

/** The statements, batch, and shutdown one connection supplies; this serialises them behind a checkout. */
export function createSingleConnectionDriver(driver: {
    query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[]; affectedRows?: number }>;
    exec(sql: string): Promise<unknown>;
    close(): Promise<void>;
}): SqlDriver {
    let turn: Promise<void> = Promise.resolve();

    /** Wait for the current turn, then hold the connection until the session is released. */
    async function take(): Promise<SqlSession> {
        const previous = turn;
        let handOff!: () => void;
        turn = new Promise<void>((resolve) => {
            handOff = resolve;
        });
        await previous;
        let released = false;
        return {
            query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => {
                const result = await driver.query(sql, parameters);
                return { rows: result.rows as Row[], affectedRows: result.affectedRows ?? 0 };
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

    return {
        // A plain statement takes the same turn, so it cannot slip inside an open boundary.
        query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
            sql: string,
            parameters?: unknown[],
        ) => {
            const session = await take();
            try {
                return await session.query<Row>(sql, parameters);
            } finally {
                session.release();
            }
        },
        connect: take,
        exec: (sql) => driver.exec(sql),
        close: () => driver.close(),
    };
}
