/** The hand-written subscription behind every generated `notify<Entity>` and `watch<Entity>`. See docs/notifications.md. */
import type { SqlExecutor, SqlSubscription } from "./sql-executor.ts";
import { NotificationsUnsupportedError } from "../errors.ts";

/** The trigger's primary-key payload, as JSON text; the plain notify stream drops it. */
export type ChangeNotification = string;

/** The pending `next()` a notification or a close settles. */
interface Waiter {
    resolve(result: IteratorResult<ChangeNotification>): void;
}

/**
 * Subscribe to `channel` until the iterator closes or `signal` aborts.
 * @throws {NotificationsUnsupportedError} when the executor has no listening connection
 */
export function subscribe(
    db: SqlExecutor,
    channel: string,
    signal?: AbortSignal,
): AsyncIterable<ChangeNotification> {
    return { [Symbol.asyncIterator]: () => createIterator(db, channel, signal) };
}

/** Drop the payload, so `notify<Entity>` keeps the "something changed" shape. */
export async function* withoutPayload(events: AsyncIterable<ChangeNotification>): AsyncIterable<void> {
    for await (const _payload of events) {
        yield;
    }
}

/** The text the trigger publishes for one key value, matching the generated SQL cast. */
function canonical(value: unknown): string {
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Uint8Array) {
        return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return String(value);
}

/** The key object a trigger published, or an empty one when the payload is not a key. */
function readKey(payload: string): Record<string, string> {
    try {
        const parsed: unknown = JSON.parse(payload);
        return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
    } catch {
        return {};
    }
}

/**
 * Yield the requested key each time its row changes; other rows on the channel are ignored.
 * @throws {NotificationsUnsupportedError} when the executor has no listening connection
 */
export async function* watchKeys<T extends Record<string, unknown>>(
    db: SqlExecutor,
    channel: string,
    keys: readonly T[],
    fields: readonly string[],
    signal?: AbortSignal,
): AsyncIterable<T> {
    if (keys.length === 0) {
        return;
    }
    for await (const payload of subscribe(db, channel, signal)) {
        const changed = readKey(payload);
        const match = keys.find((key) => fields.every((field) => canonical(key[field]) === changed[field]));
        if (match !== undefined) {
            yield match;
        }
    }
}

/**
 * The iterator a subscription hands out: it listens on the first `next()`, queues what arrives, and releases the connection on `return()`.
 * @throws {NotificationsUnsupportedError} when the executor has no listening connection
 */
function createIterator(
    db: SqlExecutor,
    channel: string,
    signal?: AbortSignal,
): AsyncIterator<ChangeNotification> {
    const queued: ChangeNotification[] = [];
    let waiter: Waiter | undefined;
    let subscription: SqlSubscription | undefined;
    // A notification that arrives before `next()` is queued; a closed iterator answers done from then on.
    let started = false;
    let closed = signal?.aborted === true;
    let failure: unknown;

    const settle = () => {
        if (waiter === undefined) {
            return;
        }
        const pending = waiter;
        waiter = undefined;
        if (closed) {
            pending.resolve({ done: true, value: undefined });
            return;
        }
        const payload = queued.shift();
        if (payload !== undefined) {
            pending.resolve({ done: false, value: payload });
        }
    };

    const notify = (payload: string) => {
        if (closed) {
            return;
        }
        queued.push(payload);
        settle();
    };

    const onAbort = () => {
        void close();
    };

    const close = async () => {
        if (closed) {
            return;
        }
        closed = true;
        signal?.removeEventListener("abort", onAbort);
        // Release the listening connection before a pending read is told the stream ended.
        const current = subscription;
        subscription = undefined;
        await current?.close();
        settle();
    };

    const start = async () => {
        if (started) {
            return;
        }
        started = true;
        if (closed) {
            return;
        }
        if (db.listen === undefined) {
            throw new NotificationsUnsupportedError();
        }
        const listener = await db.listen(channel, notify);
        if (closed) {
            await listener.close();
            return;
        }
        subscription = listener;
        signal?.addEventListener("abort", onAbort, { once: true });
        // An abort that landed between the listen and this listener would otherwise be missed.
        if (signal?.aborted) {
            await close();
        }
    };

    return {
        async next() {
            if (failure !== undefined) {
                throw failure;
            }
            if (!started) {
                try {
                    await start();
                } catch (thrown) {
                    failure = thrown;
                    throw thrown;
                }
            }
            if (closed) {
                return { done: true, value: undefined };
            }
            const payload = queued.shift();
            if (payload !== undefined) {
                return { done: false, value: payload };
            }
            return await new Promise<IteratorResult<ChangeNotification>>((resolve) => {
                waiter = { resolve };
            });
        },
        async return() {
            await close();
            return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
            failure = error;
            await close();
            throw error;
        },
    };
}
