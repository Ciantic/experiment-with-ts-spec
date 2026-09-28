/** The database surface the generated repositories use. See docs/repositories.md. */

/**
 * The minimal query interface. Both PGlite and `pg` satisfy it, so the generated
 * repositories never import a driver.
 */
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}
