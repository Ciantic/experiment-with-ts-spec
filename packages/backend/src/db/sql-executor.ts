/** The `SqlExecutor` port over a pool: a root transaction and a savepoint per nested boundary. See docs/transactions.md. */
import type { SqlPool, SqlSession } from "./sql-pool.ts";

/** The callback one boundary runs, on the handle that boundary owns. */
type Run<T> = (tx: SqlExecutor) => Promise<T>;

/** One handle: statements, and the boundary a caller can run them in. */
export interface SqlExecutor {
    /** Run one statement; the connection is not pinned across calls, so two may land on different ones. */
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    /** Run the callback in one boundary on one connection, opened with the modes the call names ahead of it; nested, that boundary is a savepoint. */
    transaction<T>(...args: [Run<T>] | [TransactionOptions, Run<T>]): Promise<T>;
}

/** The parameters one statement may carry; past this PGlite drops the statement silently, https://github.com/electric-sql/pglite/issues/1118. */
export const MAX_STATEMENT_PARAMETERS = 32767;

/** Get affected rows, compatible with both PGlite (`affectedRows`) and `pg` (`rowCount`). */
export function affectedRows(result: unknown): number {
    // `rowCount` is `number | null` in `pg`, so it is accepted only when it is a number.
    const counts = (result ?? {}) as { affectedRows?: unknown; rowCount?: unknown };
    const count = counts.affectedRows ?? counts.rowCount;
    if (typeof count !== "number") {
        throw new Error("the executor did not return an affected-row count");
    }
    return count;
}

/** Get the rows a statement returned, which both PGlite and `pg` answer under `rows`. */
export function resultRows(result: unknown): Array<Record<string, unknown>> {
    const returned = (result ?? {}) as { rows?: unknown };
    if (!Array.isArray(returned.rows)) {
        throw new Error("the executor did not return rows");
    }
    return returned.rows as Array<Record<string, unknown>>;
}

/** The modes a boundary is opened with, written into the `begin` that opens it; none of them outlives it. */
export interface TransactionOptions {
    /** `ISOLATION LEVEL …`, which only the boundary's opening statement may set. */
    readonly isolationLevel?: "serializable" | "repeatable read" | "read committed" | "read uncommitted";
    /** `READ WRITE`, the default, or `READ ONLY`. */
    readonly accessMode?: "read write" | "read only";
    /** `[NOT] DEFERRABLE`, which only matters to a boundary that is also `serializable` and `read only`. */
    readonly deferrable?: boolean;
}

/** The statement that opens a root boundary, carrying the modes the call named, in the order Postgres reads them. */
function begin(options?: TransactionOptions): string {
    const modes = options ?? {};
    const clauses = [
        modes.isolationLevel === undefined ? [] : [`isolation level ${modes.isolationLevel}`],
        modes.accessMode === undefined ? [] : [modes.accessMode],
        modes.deferrable === undefined ? [] : [modes.deferrable ? "deferrable" : "not deferrable"],
    ].flat();
    return clauses.length === 0 ? "begin" : `begin ${clauses.join(", ")}`;
}

/** A `SqlExecutor` over one checked-out session, where a nested `transaction` is a savepoint. */
export function createTransactionalDb(pool: SqlPool): SqlExecutor {
    let savepoints = 0;

    /** The handle a nested boundary runs on: queries on the same session, nesting one level deeper. */
    function handle(session: SqlSession): SqlExecutor {
        return {
            query: (sql, parameters) => session.query(sql, parameters),
            transaction: async <T>(...args: [Run<T>] | [TransactionOptions, Run<T>]) => {
                const [opts, run] = args.length === 1 ? [undefined, args[0]] : [args[0], args[1]];
                if (opts !== undefined) {
                    throw new Error("a nested boundary is a savepoint, which opens with no transaction options");
                }
                return await savepoint(session, run);
            },
        };
    }

    /** Run the callback after a savepoint, rolling back to it when the callback throws. */
    async function savepoint<T>(session: SqlSession, run: Run<T>): Promise<T> {
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
        transaction: async <T>(...args: [Run<T>] | [TransactionOptions, Run<T>]) => {
            const [opts, run] = args.length === 1 ? [undefined, args[0]] : [args[0], args[1]];
            const session = await pool.connect();
            try {
                await session.query(begin(opts));
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
