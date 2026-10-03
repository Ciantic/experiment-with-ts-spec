/** The database surface the generated repositories use. See docs/repositories.md. */

/** The minimal query interface; both PGlite and `pg` satisfy it. */
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/** An executor that can open a unit of work. See docs/transactions.md. */
export interface Db extends SqlExecutor {
    /** Run `run` inside one boundary; nested, that boundary is a savepoint. */
    transaction<T>(run: (tx: Db) => Promise<T>): Promise<T>;
}
