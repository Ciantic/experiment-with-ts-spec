/** The `SqlExecutor` port over a driver: a root transaction and a savepoint per nested boundary. See docs/transactions.md. */

/** One handle: statements, and the boundary a caller can run them in. */
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    /** Run `run` inside one boundary; nested, that boundary is a savepoint. */
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** A driver transaction handle: the query surface only, so nesting stays the port's job. */
type DriverTransaction = Pick<SqlExecutor, "query">;

/** The driver primitive the port is built on: one transaction pinned to a connection, satisfied by PGlite and by a `pg` PoolClient wrapper. */
export interface DriverConnection {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    transaction<T>(run: (tx: DriverTransaction) => Promise<T>): Promise<T>;
}

/** A `SqlExecutor` over one connection, where a nested `transaction` is a savepoint. */
export function createTransactionalDb(connection: DriverConnection): SqlExecutor {
    let savepoints = 0;

    /** The handle a nested boundary runs on: queries on the same connection, nesting one level deeper. */
    function handle(tx: DriverTransaction): SqlExecutor {
        return {
            query: (sql, parameters) => tx.query(sql, parameters),
            transaction: (run) => savepoint(tx, run),
        };
    }

    /** Run `run` after a savepoint, rolling back to it when `run` throws. */
    async function savepoint<T>(tx: DriverTransaction, run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        const name = `sp_${(savepoints += 1)}`;
        await tx.query(`savepoint ${name}`);
        try {
            const value = await run(handle(tx));
            await tx.query(`release savepoint ${name}`);
            return value;
        } catch (thrown) {
            // Rolling back to the savepoint is what clears the aborted state, so the caller
            // can keep using the outer transaction. `release` then drops the savepoint itself.
            await tx.query(`rollback to savepoint ${name}`);
            await tx.query(`release savepoint ${name}`);
            throw thrown;
        }
    }

    return {
        query: (sql, parameters) => connection.query(sql, parameters),
        transaction: (run) => connection.transaction(async (tx) => await run(handle(tx))),
    };
}
