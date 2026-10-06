/** The `SqlExecutor` port over a pool: a root transaction and a savepoint per nested boundary. See docs/transactions.md. */
import type { SqlPool, SqlSession } from "./sql-pool.ts";

/** One handle: statements, and the boundary a caller can run them in. */
export interface SqlExecutor {
    /** Run one statement; the connection is not pinned across calls, so two may land on different ones. */
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    /** Run `run` in one boundary on one connection; nested, that boundary is a savepoint. */
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/**
 * The rows a write statement affected, read from whatever the driver returned. The drivers name it
 * differently — PGlite `affectedRows`, `pg` `rowCount` — so a generated patch that has to notice an
 * unmatched row reads it through here. A result that carries neither name is a driver this does not
 * know, and answering `0` would read as a conflict, so it throws instead. See docs/versioning.md.
 */
export function affectedRows(result: unknown): number {
    // `rowCount` is `number | null` in `pg`, so it is accepted only when it is a number.
    const counts = (result ?? {}) as { affectedRows?: unknown; rowCount?: unknown };
    const count = counts.affectedRows ?? counts.rowCount;
    if (typeof count !== "number") {
        throw new Error("the executor did not return an affected-row count");
    }
    return count;
}

/** A `SqlExecutor` over one checked-out session, where a nested `transaction` is a savepoint. */
export function createTransactionalDb(pool: SqlPool): SqlExecutor {
    let savepoints = 0;

    /** The handle a nested boundary runs on: queries on the same session, nesting one level deeper. */
    function handle(session: SqlSession): SqlExecutor {
        return {
            query: (sql, parameters) => session.query(sql, parameters),
            transaction: (run) => savepoint(session, run),
        };
    }

    /** Run `run` after a savepoint, rolling back to it when `run` throws. */
    async function savepoint<T>(session: SqlSession, run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        const name = `sp_${(savepoints += 1)}`;
        await session.query(`savepoint ${name}`);
        try {
            const value = await run(handle(session));
            await session.query(`release savepoint ${name}`);
            return value;
        } catch (thrown) {
            // Rolling back to the savepoint clears the aborted state, so the outer transaction stays usable.
            await session.query(`rollback to savepoint ${name}`);
            await session.query(`release savepoint ${name}`);
            throw thrown;
        }
    }

    return {
        query: (sql, parameters) => pool.query(sql, parameters),
        transaction: async (run) => {
            const session = await pool.connect();
            try {
                await session.query("begin");
                const value = await run(handle(session));
                await session.query("commit");
                return value;
            } catch (thrown) {
                await session.query("rollback");
                throw thrown;
            } finally {
                session.release();
            }
        },
    };
}
