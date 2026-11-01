/** The hand-written subscription behind every generated `watch<Entity>`. See docs/notifications.md. */
import type { SqlExecutor, SqlSubscription } from "./sql-executor.ts";
import type { AllWatchEvent, WatchEvent, WatchOperation } from "sdk/watch.ts";
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

/** The operation a payload describes: a bare `TG_OP` from a statement trigger, or an event object. */
function operationOf(payload: string): WatchOperation | undefined {
    if (payload === "INSERT" || payload === "UPDATE" || payload === "DELETE") {
        return payload;
    }
    try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const op = (parsed as { op?: unknown }).op;
        return isWatchOperation(op) ? op : undefined;
    } catch {
        return undefined;
    }
}

/** Pass only the requested operations; omitted means every operation. */
export async function* onlyOperations(
    events: AsyncIterable<ChangeNotification>,
    ops?: readonly WatchOperation[],
): AsyncIterable<ChangeNotification> {
    if (ops === undefined) {
        for await (const payload of events) {
            yield payload;
        }
        return;
    }
    const wanted = new Set(ops);
    for await (const payload of events) {
        const op = operationOf(payload);
        if (op !== undefined && wanted.has(op)) {
            yield payload;
        }
    }
}

/** Yield every change with its operation, without a key. */
export async function* watchAll(
    db: SqlExecutor,
    channel: string,
    ops?: readonly WatchOperation[],
    signal?: AbortSignal,
    filter?: Record<string, unknown>,
): AsyncIterable<AllWatchEvent> {
    for await (const payload of onlyOperations(subscribe(db, channel, signal), ops)) {
        const event = readEvent(payload);
        const op = event?.op ?? operationOf(payload);
        if (op === undefined || !matchesFilter(event?.filter, filter)) {
            continue;
        }
        yield { op };
    }
}

/** The text the trigger publishes for one key value, matching the generated SQL cast. */
function canonical(value: unknown): string | undefined {
    if (value === null || value === undefined) {
        return undefined;
    }
    if (value instanceof Date) {
        return value.toISOString();
    }
    if (value instanceof Uint8Array) {
        return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    return String(value);
}

/** Whether a payload's filter values match the requested filter; an omitted field is unconstrained. */
function matchesFilter(
    published: Record<string, unknown> | undefined,
    filter: Record<string, unknown> | undefined,
): boolean {
    if (filter === undefined) {
        return true;
    }
    for (const [field, value] of Object.entries(filter)) {
        if (value === undefined) {
            continue;
        }
        if (published === undefined || canonical(value) !== (published[field] ?? undefined)) {
            return false;
        }
    }
    return true;
}

/** Whether a payload's operation is one a row trigger can publish. */
function isWatchOperation(value: unknown): value is WatchOperation {
    return value === "INSERT" || value === "UPDATE" || value === "DELETE";
}

/** The key, filter values, and operation a trigger published, or undefined when the payload is not an event. */
function readEvent(
    payload: string,
): { key?: Record<string, string>; filter?: Record<string, string>; op: WatchOperation } | undefined {
    try {
        const parsed: unknown = JSON.parse(payload);
        if (typeof parsed !== "object" || parsed === null) {
            return undefined;
        }
        const event = parsed as { key?: unknown; filter?: unknown; op?: unknown };
        if (!isWatchOperation(event.op)) {
            return undefined;
        }
        const key = valuesOf(event.key);
        const filter = valuesOf(event.filter);
        return {
            ...(key === undefined ? {} : { key }),
            ...(filter === undefined ? {} : { filter }),
            op: event.op,
        };
    } catch {
        return undefined;
    }
}

/** The string-valued object a payload carries, or undefined when it carries none. */
function valuesOf(value: unknown): Record<string, string> | undefined {
    if (typeof value !== "object" || value === null) {
        return undefined;
    }
    return value as Record<string, string>;
}

/**
 * Yield the requested row each time it changes; other rows on the channel are ignored.
 * @throws {NotificationsUnsupportedError} when the executor has no listening connection
 */
export async function* watchRows<T extends Record<string, unknown>>(
    db: SqlExecutor,
    channel: string,
    keys: readonly T[],
    fields: readonly string[],
    ops?: readonly WatchOperation[],
    signal?: AbortSignal,
    filter?: Record<string, unknown>,
): AsyncIterable<WatchEvent<T>> {
    if (keys.length === 0) {
        return;
    }
    const wanted = ops === undefined ? undefined : new Set(ops);
    for await (const payload of subscribe(db, channel, signal)) {
        const event = readEvent(payload);
        if (
            event === undefined ||
            event.key === undefined ||
            (wanted !== undefined && !wanted.has(event.op)) ||
            !matchesFilter(event.filter, filter)
        ) {
            continue;
        }
        const match = keys.find((key) =>
            fields.every((field) => (canonical(key[field]) ?? undefined) === (event.key?.[field] ?? undefined)),
        );
        if (match !== undefined) {
            yield { pks: match, op: event.op };
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
