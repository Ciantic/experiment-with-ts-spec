/** A `node:http` server over the generated route table; the router owns every decision. See docs/rest-api.md. */
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AppContext } from "../context.ts";
import { errorFrom } from "./http-response.ts";
import { routes } from "./routes/index.ts";
import { createRouter, type HttpResponse } from "./router.ts";

/** Write a router response. */
function write(response: ServerResponse, result: HttpResponse): void {
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(result.body);
}

/** A server exposing the generated route table; `app` is what startup built and every request's context is built over. */
export function createApiServer(app: AppContext): Server {
    const router = createRouter(app, routes);
    return createServer((request, response) => {
        void (async () => {
            try {
                // The router owns the request: its method, its URL, and its body.
                write(response, await router.handle(request));
            } catch (thrown) {
                write(response, errorFrom(thrown));
            }
        })();
    });
}
