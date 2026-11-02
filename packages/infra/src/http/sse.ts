/** A server-sent event stream a route answers with instead of a value. See docs/notifications.md. */
import type { ServerResponse } from "node:http";
import { stringify as encode } from "devalue";
import { WritableResponse } from "./api-http-response.ts";

/** The events a stream writes; the server opens it with the signal that ends with the response. */
export class SseStream extends WritableResponse {
    readonly #open: (signal: AbortSignal) => AsyncIterable<unknown>;

    constructor(open: (signal: AbortSignal) => AsyncIterable<unknown>) {
        super();
        this.#open = open;
    }

    /** Write the stream to `response` until it ends or the client closes it. */
    writeTo(response: ServerResponse): void {
        response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        });
        const abort = new AbortController();
        const onClose = () => abort.abort();
        response.on("close", onClose);
        // Send the event-stream headers before the first change, so a client's `fetch` resolves.
        response.flushHeaders();

        void (async () => {
            try {
                for await (const event of this.#open(abort.signal)) {
                    // A plain notify carries no payload; a watch carries the key, in the same codec as the rest of the API.
                    response.write(event === undefined ? "data: \n\n" : `data: ${encode(event)}\n\n`);
                }
                response.end();
            } catch {
                response.destroy();
            } finally {
                response.off("close", onClose);
                abort.abort();
            }
        })();
    }
}
