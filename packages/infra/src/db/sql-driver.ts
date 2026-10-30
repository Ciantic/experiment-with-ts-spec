/** The driver port, and the executor a caller derives from it. See docs/transactions.md. */
import { SavepointOptionsError } from "sdk/errors.ts";
import type { Run, SqlExecutor, TransactionOptions } from "./sql-executor.ts";

/** A connection borrowed for one boundary: statements, and the release that returns it. */
export interface SqlConnection {
    query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }>;
    release(): void;
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

/** The process's driver: statements, checkouts, the DDL batch, shutdown, and the executor a caller derives from it. */
export abstract class SqlDriver {
    /** Run one statement; the connection is not pinned across calls, so two may land on different ones. */
    abstract query<Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string,
        parameters?: unknown[],
    ): Promise<{ rows: Row[]; affectedRows: number }>;
    /** Borrow one connection, held until its release; only a boundary takes one. */
    protected abstract connect(): Promise<SqlConnection>;
    /** Run a batch of statements, the generated DDL included. */
    abstract exec(sql: string): Promise<unknown>;
    /** Release the driver's resources. */
    abstract close(): Promise<void>;

    /** One request's handle over this driver, with its own savepoint counter. */
    createExecutor(): SqlExecutor {
        let savepoints = 0;

        /**
         * The handle a nested boundary runs on: queries on the same connection, nesting one level deeper.
         * @throws {SavepointOptionsError} when a nested boundary is asked for transaction options
         */
        function handle(connection: SqlConnection): SqlExecutor {
            return {
                query: <Row extends Record<string, unknown> = Record<string, unknown>>(
                    sql: string,
                    parameters?: unknown[],
                ) => connection.query<Row>(sql, parameters),
                transaction: (run) => savepoint(connection, run),
                transactionWith: async () => {
                    throw new SavepointOptionsError(
                        "a nested boundary is a savepoint, which opens with no transaction options",
                    );
                },
            };
        }

        /** Run the callback after a savepoint, rolling back to it when the callback throws. */
        async function savepoint<T>(connection: SqlConnection, run: Run<T>): Promise<T> {
            const name = `sp_${(savepoints += 1)}`;
            await connection.query(`savepoint ${name}`);
            try {
                const value = await run(handle(connection));
                await connection.query(`release savepoint ${name}`);
                return value;
            } catch (thrown) {
                // Rolling back to the savepoint clears the aborted state, so the outer transaction stays usable.
                await connection.query(`rollback to savepoint ${name}`);
                await connection.query(`release savepoint ${name}`);
                throw thrown;
            }
        }

        /** Open a root boundary on one checked-out connection, carrying the modes the call named, and roll it back when the callback throws. */
        const boundary = async <T>(options: TransactionOptions | undefined, run: Run<T>): Promise<T> => {
            const connection = await this.connect();
            try {
                await connection.query(begin(options));
                const value = await run(handle(connection));
                await connection.query("commit");
                return value;
            } catch (thrown) {
                await connection.query("rollback");
                throw thrown;
            } finally {
                connection.release();
            }
        };

        return {
            query: <Row extends Record<string, unknown> = Record<string, unknown>>(
                sql: string,
                parameters?: unknown[],
            ) => this.query<Row>(sql, parameters),
            transaction: (run) => boundary(undefined, run),
            transactionWith: (options, run) => boundary(options, run),
        };
    }
}
