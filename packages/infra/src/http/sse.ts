/** A server-sent event stream a route answers with instead of a value. See docs/notifications.md. */

/** The events a stream writes; the server opens it with the signal that ends with the response. */
export class SseStream {
    readonly open: (signal: AbortSignal) => AsyncIterable<unknown>;

    constructor(open: (signal: AbortSignal) => AsyncIterable<unknown>) {
        this.open = open;
    }
}
