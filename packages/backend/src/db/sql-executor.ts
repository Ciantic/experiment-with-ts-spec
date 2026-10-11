/** The `SqlExecutor` port over a pool: a root transaction and a savepoint per nested boundary. See docs/transactions.md. */
import type { SqlPool, SqlSession } from "./sql-pool.ts";

/** One handle: statements, and the boundary a caller can run them in. */
export interface SqlExecutor {
    /** Run one statement; the connection is not pinned across calls, so two may land on different ones. */
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    /** Run `run` in one boundary on one connection; nested, that boundary is a savepoint. */
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
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

/** The characteristics `SET TRANSACTION` puts on the boundary it runs in, none of which outlives it. */
export interface SetTransactionOptions {
    /** `ISOLATION LEVEL …`, which only the boundary's first statement may set. */
    readonly isolationLevel?: "serializable" | "repeatable read" | "read committed" | "read uncommitted";
    /** `READ WRITE`, the default, or `READ ONLY`. */
    readonly accessMode?: "read write" | "read only";
    /** `[NOT] DEFERRABLE`, which only matters to a boundary that is also `serializable` and `read only`. */
    readonly deferrable?: boolean;
    /** The identifier `pg_export_snapshot` answered, which the command takes alone. */
    readonly snapshot?: string;
}

/** Set the characteristics of the boundary `db` is in, as that boundary's first statement. */
export async function setTransaction(db: SqlExecutor, modes: SetTransactionOptions): Promise<void> {
    if (modes.snapshot !== undefined) {
        if (modes.isolationLevel !== undefined || modes.accessMode !== undefined || modes.deferrable !== undefined) {
            throw new Error("a snapshot is the only mode a set transaction may carry");
        }
        // The identifier is inline because the command takes a literal, not a parameter; a quote or a backslash is refused, not escaped.
        if (/['\\]/.test(modes.snapshot)) {
            throw new Error("a snapshot identifier carries no quote and no backslash");
        }
        await db.query(`set transaction snapshot '${modes.snapshot}'`);
        return;
    }

    const clauses = [
        modes.isolationLevel === undefined ? [] : [`isolation level ${modes.isolationLevel}`],
        modes.accessMode === undefined ? [] : [modes.accessMode],
        modes.deferrable === undefined ? [] : [modes.deferrable ? "deferrable" : "not deferrable"],
    ].flat();
    if (clauses.length === 0) {
        throw new Error("a set transaction needs at least one mode");
    }
    await db.query(`set transaction ${clauses.join(", ")}`);
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
