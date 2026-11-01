/** A `node:http` server over the generated route table; the router owns every decision. See docs/rest-api.md. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AppContext } from "../context.ts";
import { ApiHttpResponse } from "./api-http-response.ts";
import { createRouter, type Route } from "./router.ts";
import { SseStream } from "./sse.ts";

/** Write a router response. */
function write(response: ServerResponse, result: ApiHttpResponse): void {
    const wire = result.toWire();
    response.writeHead(wire.statusCode, wire.headers);
    response.end(wire.body);
}

/** Write an event stream until it ends or the client closes the response. */
function writeStream(response: ServerResponse, stream: SseStream): void {
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
            for await (const event of stream.open(abort.signal)) {
                // A notification has no payload, so the data line is empty; the event itself is the message.
                response.write(event === undefined ? "data: \n\n" : `data: ${JSON.stringify(event)}\n\n`);
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

/** A server exposing `routes`; `app` is what startup built and every request's context is built over. */
export function createApiServer(app: AppContext, routes: Route[]): Server {
    const router = createRouter(app, routes);
    return createServer((request, response) => {
        void (async () => {
            try {
                // The router owns the request: its method, its URL, and its body.
                const result = await router.handle(request);
                if (result instanceof SseStream) {
                    writeStream(response, result);
                    return;
                }
                write(response, ApiHttpResponse.ok(result));
            } catch (thrown) {
                write(response, ApiHttpResponse.failure(thrown));
            }
        })();
    });
}
