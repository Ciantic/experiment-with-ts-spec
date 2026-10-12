/** The three group boundaries over the `SqlExecutor` port, named as the SDK names them. See docs/transactions.md. */
import type { SqlExecutor, TransactionOptions } from "./sql-executor.ts";

/** One unit of work. Whatever `SqlExecutor` it is handed is the boundary it runs inside. */
export type Step = (db: SqlExecutor) => Promise<unknown>;

/** The results of `T`, in order. */
type Results<T extends readonly Step[]> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/** A tolerated boundary's outcome: what it produced, or the failure that rolled it back. */
export type Attempted<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };

/** Run every step on `db`, in order. */
async function run<T extends readonly Step[]>(db: SqlExecutor, steps: T): Promise<Results<T>> {
    const results: unknown[] = [];
    for (const step of steps) {
        results.push(await step(db));
    }
    // Index `i` is step `i`; only the variadic spread loses that from the types.
    return results as Results<T>;
}

/** Run every step on `db` itself, so no step shares a boundary with another. */
export async function batch<const T extends readonly Step[]>(db: SqlExecutor, ...steps: T): Promise<Results<T>> {
    return await run(db, steps);
}

/** Run every step on one boundary, so a failure discards all of them. */
export async function transaction<const T extends readonly Step[]>(
    db: SqlExecutor,
    ...steps: T
): Promise<Results<T>> {
    return await db.transaction(async (tx) => await run(tx, steps));
}

/** {@link transaction}, on a boundary opened with the modes the call names. */
export async function transactionWith<const T extends readonly Step[]>(
    db: SqlExecutor,
    options: TransactionOptions,
    ...steps: T
): Promise<Results<T>> {
    return await db.transactionWith(options, async (tx) => await run(tx, steps));
}

/** {@link transaction}, reporting its own failure instead of raising it. */
export async function attempt<const T extends readonly Step[]>(
    db: SqlExecutor,
    ...steps: T
): Promise<Attempted<Results<T>>> {
    return await tolerate(async () => await transaction(db, ...steps));
}

/** {@link attempt}, on a boundary opened with the modes the call names. */
export async function attemptWith<const T extends readonly Step[]>(
    db: SqlExecutor,
    options: TransactionOptions,
    ...steps: T
): Promise<Attempted<Results<T>>> {
    return await tolerate(async () => await transactionWith(db, options, ...steps));
}

/** Answer with what `open` produced, or with the failure that rolled its boundary back. */
async function tolerate<T>(open: () => Promise<T>): Promise<Attempted<T>> {
    try {
        return { ok: true, value: await open() };
    } catch (error) {
        return { ok: false, error };
    }
}
