/** The pool port, and the one-connection pool a single-session driver reaches it through. See docs/transactions.md. */

/** The session a boundary is pinned to: statements, and the release that hands the connection on. */
export interface SqlSession {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    release(): void;
}

/** The whole surface a boundary is built on: statements, and a checkout that pins one session to it. */
export interface SqlPool {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    connect(): Promise<SqlSession>;
}

/** A pool over one connection: a checkout holds it, so a boundary cannot interleave with another. */
export function createSingleConnectionPool(
    run: (sql: string, parameters?: unknown[]) => Promise<unknown>,
): SqlPool {
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
            query: (sql, parameters) => run(sql, parameters),
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
        query: async (sql, parameters) => {
            const session = await take();
            try {
                return await session.query(sql, parameters);
            } finally {
                session.release();
            }
        },
        connect: take,
    };
}
