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

/** What a boundary-opening group is called with: its steps, or the modes ahead of them. */
type Args<T extends readonly Step[]> = [TransactionOptions, ...T] | T;

/** What a grouped call's arguments hold once its first element has said which of the two shapes arrived. */
type Split = [TransactionOptions | undefined, ...Step[]];

/** Run every step on `db`, in order. */
async function run(db: SqlExecutor, steps: readonly Step[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const step of steps) {
        results.push(await step(db));
    }
    return results;
}

/** Run every step on `db` itself, so no step shares a boundary with another. */
export async function batch<const T extends readonly Step[]>(db: SqlExecutor, ...steps: T): Promise<Results<T>> {
    // Index `i` is step `i`; only the variadic spread loses that from the types.
    return (await run(db, steps)) as Results<T>;
}

/** Run every step on one boundary, so a failure discards all of them. */
export function transaction<const T extends readonly Step[]>(db: SqlExecutor, ...steps: T): Promise<Results<T>>;
export function transaction<const T extends readonly Step[]>(
    db: SqlExecutor,
    options: TransactionOptions,
    ...steps: T
): Promise<Results<T>>;
export async function transaction<const T extends readonly Step[]>(
    db: SqlExecutor,
    ...args: Args<T>
): Promise<Results<T>> {
    // A step is a function and the modes ahead of one are not, so the first argument says which shape this is.
    const [options, ...steps] = (typeof args[0] === "function" ? [undefined, ...args] : args) as Split;
    const stepsIn = async (tx: SqlExecutor) => await run(tx, steps);
    const value = options === undefined ? await db.transaction(stepsIn) : await db.transaction(options, stepsIn);
    return value as Results<T>;
}

/** {@link transaction}, reporting its own failure instead of raising it. */
export function attempt<const T extends readonly Step[]>(
    db: SqlExecutor,
    ...steps: T
): Promise<Attempted<Results<T>>>;
export function attempt<const T extends readonly Step[]>(
    db: SqlExecutor,
    options: TransactionOptions,
    ...steps: T
): Promise<Attempted<Results<T>>>;
export async function attempt<const T extends readonly Step[]>(
    db: SqlExecutor,
    ...args: Args<T>
): Promise<Attempted<Results<T>>> {
    const [options, ...steps] = (typeof args[0] === "function" ? [undefined, ...args] : args) as Split;
    try {
        const value = options === undefined ? await transaction(db, ...steps) : await transaction(db, options, ...steps);
        return { ok: true, value: value as Results<T> };
    } catch (error) {
        return { ok: false, error };
    }
}
