/** The database surface the generated repositories use. See docs/repositories.md. */

/**
 * The minimal query interface. Both PGlite and `pg` satisfy it, so the generated
 * repositories never import a driver.
 */
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
}

/**
 * A query surface that returns rows, for read paths. Both PGlite and `pg`
 * resolve to a result carrying `rows`, so the GraphQL loaders never import a
 * driver either. See docs/graphql.md.
 */
export interface RowExecutor {
    query(sql: string, parameters?: unknown[]): Promise<{ rows: unknown[] }>;
}
