/** The hand-written subscription behind every generated `notify<Entity>` function. See docs/notifications.md. */
import type { SqlExecutor, SqlSubscription } from "./sql-executor.ts";
import { NotificationsUnsupportedError } from "../errors.ts";

/** A change notification carries no payload today; the event is the message. */
export type ChangeNotification = void;

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
        if (queued.length > 0) {
            queued.shift();
            pending.resolve({ done: false, value: undefined });
        }
    };

    const notify = () => {
        if (closed) {
            return;
        }
        queued.push(undefined);
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
            if (queued.length > 0) {
                queued.shift();
                return { done: false, value: undefined };
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
