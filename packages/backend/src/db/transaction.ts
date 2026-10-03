/**
 * The `Db` port over a driver: one real transaction at the root, a savepoint for
 * every nested boundary. See docs/transactions.md.
 *
 * The root uses the driver's own transaction primitive because it is the thing
 * that pins a connection and, on PGlite, holds the exclusive lock that keeps two
 * requests from interleaving their `begin`…`commit`. Nesting is savepoints issued
 * on the handle that transaction supplied, which is what lets an inner boundary
 * roll back without discarding the outer one.
 */
import type { Db, SqlExecutor } from "./sql-executor.ts";

/** The driver primitive the port is built on: one transaction, pinned to a connection. */
export interface TransactionalConnection extends SqlExecutor {
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** A `Db` over one connection, where a nested `transaction` is a savepoint. */
export function createTransactionalDb(connection: TransactionalConnection): Db {
    let savepoints = 0;

    /** The handle a nested boundary runs on: queries on the same connection, nesting one level deeper. */
    function handle(tx: SqlExecutor): Db {
        return {
            query: (sql, parameters) => tx.query(sql, parameters),
            transaction: (run) => savepoint(tx, run),
        };
    }

    /** Run `run` after a savepoint, rolling back to it when `run` throws. */
    async function savepoint<T>(tx: SqlExecutor, run: (tx: Db) => Promise<T>): Promise<T> {
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
