/** A `node:http` server over the generated route table; the router owns every decision. See docs/rest-api.md. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AppContext } from "../context.ts";
import { ApiHttpResponse } from "./api-http-response.ts";
import { ApiRouter, type HttpRouter, type Route } from "./router.ts";
import { SseStream } from "./sse.ts";

/** 
 * The server lifecycle the entry point drives. 
 * 
 * @see {ApiServer} to create an instance of the server
 **/
export interface HttpServer {
    /** Listen on `port`; `0` picks a free one. Resolves with the bound port. */
    listen(port: number): Promise<number>;
    /** Stop accepting requests and close the open connections. */
    close(): Promise<void>;
}

/** A `node:http` server over the generated route table; the router owns every decision. */
export class ApiServer implements HttpServer {
    readonly #router: HttpRouter;
    readonly #server: Server;

    constructor(app: AppContext, routes: Route[]) {
        this.#router = new ApiRouter(app, routes);
        this.#server = createServer((request, response) => {
            void this.#handle(request, response);
        });
    }

    /** Answer one request with the router's result, or the failure it raised. */
    async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            // The router owns the request: its method, its URL, and its body.
            const result = await this.#router.handle(request);
            if (result instanceof SseStream) {
                result.writeTo(response);
                return;
            }
            ApiHttpResponse.ok(result).writeTo(response);
        } catch (thrown) {
            ApiHttpResponse.failure(thrown).writeTo(response);
        }
    }

    /** Listen on `port`; `0` picks a free one. Resolves with the bound port. */
    listen(port: number): Promise<number> {
        return new Promise((resolve, reject) => {
            const onError = (error: Error) => reject(error);
            this.#server.once("error", onError);
            this.#server.listen(port, () => {
                this.#server.off("error", onError);
                const address = this.#server.address();
                resolve(typeof address === "object" && address !== null ? address.port : port);
            });
        });
    }

    /** Stop accepting requests and close the open connections. */
    async close(): Promise<void> {
        if (!this.#server.listening) {
            return;
        }
        await new Promise<void>((resolve, reject) => {
            this.#server.close((error) => (error ? reject(error) : resolve()));
        });
    }
}
