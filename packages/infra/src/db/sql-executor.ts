/** The `SqlExecutor` port, the result one statement answers, and the transaction modes a boundary opens with. See docs/transactions.md. */

/** The callback one boundary runs, on the handle that boundary owns. */
export type Run<T> = (tx: SqlExecutor) => Promise<T>;

/** What one statement answers: its rows and the count its command tag carries. */
export interface QueryResult<Row> {
    /** The rows the statement returned; empty for a write without `returning`. */
    rows: Row[];
    /** The rows the command tag counts; `null` when it carries none, as `show` and `explain` do. */
    rowCount: number | null;
}

/** One handle: statements, and the boundary a caller can run them in; a root handle is not a connection, so two of its calls may land on different ones. */
export interface SqlExecutor {
    /** Run one statement, answering its rows and its row count. */
    query<Row extends object = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<QueryResult<Row>>;
    /** Run the callback in one boundary on one connection; nested, that boundary is a savepoint. */
    transaction<T>(run: Run<T>): Promise<T>;
    /** {@link transaction}, on a root boundary opened with the modes the call names ahead of it. */
    transactionWith<T>(options: TransactionOptions, run: Run<T>): Promise<T>;
}

/** The parameters one statement may carry; past this PGlite drops the statement silently, https://github.com/electric-sql/pglite/issues/1118. */
export const MAX_STATEMENT_PARAMETERS = 32767;

/** The isolation levels a boundary may open at, the literals `ISOLATION LEVEL` takes; a caller that validates untrusted input checks against these. */
export const ISOLATION_LEVELS = ["serializable", "repeatable read", "read committed", "read uncommitted"] as const;

/** The access modes a boundary may open in. */
export const ACCESS_MODES = ["read write", "read only"] as const;

/** The modes a boundary is opened with, written into the `begin` that opens it; none of them outlives it. */
export interface TransactionOptions {
    /** `ISOLATION LEVEL …`, which only the boundary's opening statement may set. */
    readonly isolationLevel?: (typeof ISOLATION_LEVELS)[number];
    /** `READ WRITE`, the default, or `READ ONLY`. */
    readonly accessMode?: (typeof ACCESS_MODES)[number];
    /** `[NOT] DEFERRABLE`, which only matters to a boundary that is also `serializable` and `read only`. */
    readonly deferrable?: boolean;
}
