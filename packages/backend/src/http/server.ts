/** A `node:http` server over the generated route table; the router owns every decision. See docs/rest-api.md. */
import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { PayloadTooLargeError } from "sdk/errors.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { errorFrom } from "./http-response.ts";
import { routes } from "./routes/index.ts";
import { createRouter, type HttpResponse } from "./router.ts";

/** The largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Read a request body, refusing one larger than {@link MAX_BODY_BYTES}.
 * @throws {PayloadTooLargeError} when the body passes the byte cap
 */
async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request as AsyncIterable<Buffer>) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            throw new PayloadTooLargeError("request body too large");
        }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8");
}

/** Write a router response. */
function write(response: ServerResponse, result: HttpResponse): void {
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(result.body);
}

/** A server exposing the generated route table over `db`. */
export function createApiServer(db: SqlExecutor): Server {
    const router = createRouter(db, routes);
    return createServer((request, response) => {
        void (async () => {
            const method = request.method ?? "GET";
            // The router owns URL interpretation, so the server passes it through whole.
            const url = request.url ?? "/";
            try {
                write(response, await router.handle({ method, url, body: await readBody(request) }));
            } catch (thrown) {
                write(response, errorFrom(thrown));
            }
        })();
    });
}
