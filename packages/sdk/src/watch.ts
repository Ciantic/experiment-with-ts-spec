/** The typed server-sent event helper behind every generated `notify<Entity>`. See docs/notifications.md. */
import { AppError } from "./errorBase.ts";

/** The part of an `EventSource` a subscription uses; the event itself carries no payload. */
export interface EventSourceLike {
    onmessage: (() => void) | null;
    close(): void;
}

/** Builds an `EventSource` over a URL, so a test or a non-browser host can supply one. */
export interface EventSourceConstructor {
    new (url: string): EventSourceLike;
}

/** How a change subscription is opened. */
export interface WatchOptions {
    /** The `EventSource` implementation; defaults to the platform's global. */
    source?: EventSourceConstructor;
}

/** A live change subscription. */
export interface NotificationSubscription {
    /** Stop listening and close the connection. */
    close(): void;
}

/** A platform without an `EventSource` and no implementation supplied. */
export class EventSourceUnavailableError extends AppError {
    constructor(message: string) {
        super(message, { kind: "event-source-unavailable", status: 500 });
    }
}

/**
 * Open a server-sent event stream and call `onChange` for each event.
 * @throws {EventSourceUnavailableError} when the platform has no `EventSource` and `options.source` supplies none
 */
export function watch(url: string, onChange: () => void, options: WatchOptions = {}): NotificationSubscription {
    const Source = options.source ?? platformEventSource();
    const source = new Source(url);
    source.onmessage = () => onChange();
    return { close: () => source.close() };
}

/** The platform's `EventSource`, when it has one.
 * @throws {EventSourceUnavailableError} when the platform has no `EventSource`
 */
function platformEventSource(): EventSourceConstructor {
    const source = (globalThis as { EventSource?: EventSourceConstructor }).EventSource;
    if (source === undefined) {
        throw new EventSourceUnavailableError("this platform has no EventSource; pass one in options.source");
    }
    return source;
}
