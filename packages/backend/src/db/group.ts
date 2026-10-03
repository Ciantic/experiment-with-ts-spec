/**
 * The boundary semantics a group of calls has, over the `Db` port. See
 * docs/transactions.md.
 *
 * A step is one unit of work that is handed the `Db` it must run on. The three
 * functions differ in exactly two ways: whether their steps share a boundary, and
 * whether a step's failure is raised or reported. Nothing here knows about HTTP,
 * routes, or call trees.
 */
import type { Db } from "./sql-executor.ts";

/** One unit of work. Whatever `Db` it is handed is the boundary it runs inside. */
export type Step = (db: Db) => Promise<unknown>;

/** A failure that was reported rather than raised. The caller decides what it means. */
export type Outcome =
    | { readonly ok: true; readonly value: unknown[] }
    | { readonly ok: false; readonly error: unknown };

/** Run every step on `db` itself, so no step shares a boundary with another. */
export async function sequence(db: Db, steps: readonly Step[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const step of steps) {
        results.push(await step(db));
    }
    return results;
}

/** Run every step on one boundary, so a failure discards all of them. */
export async function atomically(db: Db, steps: readonly Step[]): Promise<unknown[]> {
    return await db.transaction(async (tx) => await sequence(tx, steps));
}

/** {@link atomically}, reporting its own failure instead of raising it. */
export async function tolerating(db: Db, steps: readonly Step[]): Promise<Outcome> {
    try {
        return { ok: true, value: await atomically(db, steps) };
    } catch (error) {
        return { ok: false, error };
    }
}
