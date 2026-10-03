/** The three group boundaries over the `Db` port, named as the SDK names them. See docs/transactions.md. */
import type { Db } from "./sql-executor.ts";

/** One unit of work. Whatever `Db` it is handed is the boundary it runs inside. */
export type Step = (db: Db) => Promise<unknown>;

/** The results of `T`, in order. */
type Results<T extends readonly Step[]> = { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };

/** A tolerated boundary's outcome: what it produced, or the failure that rolled it back. */
export type Attempted<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };

/** Run every step on `db`, in order. */
async function run(db: Db, steps: readonly Step[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const step of steps) {
        results.push(await step(db));
    }
    return results;
}

/** Run every step on `db` itself, so no step shares a boundary with another. */
export async function batch<const T extends readonly Step[]>(db: Db, ...steps: T): Promise<Results<T>> {
    // Index `i` is step `i`; only the variadic spread loses that from the types.
    return (await run(db, steps)) as Results<T>;
}

/** Run every step on one boundary, so a failure discards all of them. */
export async function transaction<const T extends readonly Step[]>(db: Db, ...steps: T): Promise<Results<T>> {
    return (await db.transaction(async (tx) => await run(tx, steps))) as Results<T>;
}

/** {@link transaction}, reporting its own failure instead of raising it. */
export async function attempt<const T extends readonly Step[]>(
    db: Db,
    ...steps: T
): Promise<Attempted<Results<T>>> {
    try {
        return { ok: true, value: await transaction(db, ...steps) };
    } catch (error) {
        return { ok: false, error };
    }
}
