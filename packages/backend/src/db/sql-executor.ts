/** The database surface the generated repositories use. See docs/repositories.md. */

/**
 * The minimal query interface. Both PGlite and `pg` satisfy it, so the generated
 * repositories never import a driver.
 */
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * An executor that can open a unit of work. A repository takes `SqlExecutor`, so
 * it cannot open one; the things that own a boundary — the router, an operation
 * implementation — take this. See docs/transactions.md.
 */
export interface Db extends SqlExecutor {
    /**
     * Run `run` inside one transaction. The handle it receives is a `Db` as well,
     * so a nested call opens a savepoint rather than a second transaction: it can
     * roll back on its own, and the outer boundary survives it.
     */
    transaction<T>(run: (tx: Db) => Promise<T>): Promise<T>;
}
