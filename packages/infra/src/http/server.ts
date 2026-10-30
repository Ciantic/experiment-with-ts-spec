/** A `node:http` server over the generated route table; the router owns every decision. See docs/rest-api.md. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AppContext } from "../context.ts";
import { ApiHttpResponse } from "./api-http-response.ts";
import { createRouter, type Route } from "./router.ts";

/** Write a router response. */
function write(response: ServerResponse, result: ApiHttpResponse): void {
    const wire = result.toWire();
    response.writeHead(wire.statusCode, wire.headers);
    response.end(wire.body);
}

/** A server exposing `routes`; `app` is what startup built and every request's context is built over. */
export function createApiServer(app: AppContext, routes: Route[]): Server {
    const router = createRouter(app, routes);
    return createServer((request, response) => {
        void (async () => {
            try {
                // The router owns the request: its method, its URL, and its body.
                write(response, ApiHttpResponse.ok(await router.handle(request)));
            } catch (thrown) {
                write(response, ApiHttpResponse.failure(thrown));
            }
        })();
    });
}
