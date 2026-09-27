/** A framework-free GraphQL-over-HTTP handler. See docs/graphql.md. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { graphql, printSchema, type GraphQLSchema } from "graphql";
import { PLAYGROUND_HTML } from "./playground.js";

/** The largest request body accepted, so a client cannot exhaust memory with one request. */
const MAX_BODY_BYTES = 1_048_576;

export interface GraphQLRequestHandlerOptions {
    /** The executable schema. The generated one lives in `../graphql/schema.js`. */
    schema: GraphQLSchema;
    /**
     * Build the per-request context, called once per GraphQL request. Loaders are
     * per-request, so sharing one context across requests serves stale rows.
     */
    context: (request: IncomingMessage) => unknown | Promise<unknown>;
    /** Serve a GraphiQL page at `/`. Defaults to true. */
    playground?: boolean;
}

/** A parsed GraphQL request, whatever the transport spelled it in. */
interface GraphQLRequest {
    query: string;
    variables?: Record<string, unknown>;
    operationName?: string;
}

function send(response: ServerResponse, status: number, body: string, contentType: string): void {
    response.writeHead(status, {
        "content-type": contentType,
        "content-length": Buffer.byteLength(body),
        // A dev convenience: an external GraphiQL or script on another origin can call the server.
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
    });
    response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
    send(response, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

/** A GraphQL-over-HTTP error: a well-formed request whose execution failed still answers 200. */
function sendRequestError(response: ServerResponse, status: number, message: string): void {
    sendJson(response, status, { errors: [{ message }] });
}

async function readBody(request: IncomingMessage): Promise<string> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = chunk as Buffer;
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new Error("request body is too large");
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function readVariables(value: unknown): Record<string, unknown> | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }
    if (typeof value === "string") {
        const parsed: unknown = JSON.parse(value);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            throw new Error("variables must be a JSON object");
        }
        return parsed as Record<string, unknown>;
    }
    if (typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    throw new Error("variables must be a JSON object");
}

function readOperationName(value: unknown): string | undefined {
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Read the query, variables, and operation name from a JSON or `application/graphql` body. */
function parsePostBody(body: string, contentType: string): GraphQLRequest {
    const trimmed = body.trim();
    if (trimmed.length === 0) {
        throw new Error("a request body is required");
    }
    if (contentType.includes("application/graphql")) {
        return { query: trimmed };
    }
    const isJson = contentType.includes("application/json");
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        // A bare query string is accepted unless the client declared JSON, where invalid JSON is an error.
        if (isJson) {
            throw new Error("the request body is not valid JSON");
        }
        return { query: trimmed };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("the request body must be a JSON object");
    }
    const fields = parsed as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof fields.query !== "string" || fields.query.trim().length === 0) {
        throw new Error("a query is required");
    }
    const request: GraphQLRequest = { query: fields.query };
    const variables = readVariables(fields.variables);
    if (variables) {
        request.variables = variables;
    }
    const operationName = readOperationName(fields.operationName);
    if (operationName) {
        request.operationName = operationName;
    }
    return request;
}

function parseGetRequest(url: URL): GraphQLRequest {
    const query = url.searchParams.get("query");
    if (query === null || query.trim().length === 0) {
        throw new Error("a query is required");
    }
    const request: GraphQLRequest = { query };
    const variables = readVariables(url.searchParams.get("variables"));
    if (variables) {
        request.variables = variables;
    }
    const operationName = readOperationName(url.searchParams.get("operationName"));
    if (operationName) {
        request.operationName = operationName;
    }
    return request;
}

/**
 * Build a Node request listener serving GraphQL at `/graphql`, the SDL at `/schema`,
 * and (by default) a GraphiQL playground at `/`. The handler knows nothing about the
 * domain: it takes whatever schema and context it is given.
 */
export function createRequestHandler(
    options: GraphQLRequestHandlerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
    const playground = options.playground ?? true;

    return async (request, response) => {
        try {
            // The base is a placeholder; only the path and query parameters are read.
            const url = new URL(request.url ?? "/", "http://localhost");
            const method = request.method ?? "GET";

            if (method === "OPTIONS") {
                send(response, 204, "", "text/plain; charset=utf-8");
                return;
            }

            if (url.pathname === "/schema" && (method === "GET" || method === "HEAD")) {
                send(response, 200, printSchema(options.schema), "text/plain; charset=utf-8");
                return;
            }

            if ((url.pathname === "/" || url.pathname === "/playground") && method === "GET") {
                if (!playground) {
                    sendJson(response, 404, { errors: [{ message: "the playground is disabled" }] });
                    return;
                }
                send(response, 200, PLAYGROUND_HTML, "text/html; charset=utf-8");
                return;
            }

            if (url.pathname !== "/graphql") {
                sendJson(response, 404, { errors: [{ message: `no route for ${url.pathname}` }] });
                return;
            }

            if (method !== "GET" && method !== "POST") {
                response.setHeader("allow", "GET, POST, OPTIONS");
                sendRequestError(response, 405, `method ${method} is not allowed`);
                return;
            }

            let parsed: GraphQLRequest;
            try {
                parsed =
                    method === "POST"
                        ? parsePostBody(await readBody(request), request.headers["content-type"] ?? "")
                        : parseGetRequest(url);
            } catch (error) {
                sendRequestError(response, 400, error instanceof Error ? error.message : "bad request");
                return;
            }

            // GraphQL-over-HTTP reports execution errors inside a 200 response; malformed requests are 400.
            const result = await graphql({
                schema: options.schema,
                source: parsed.query,
                contextValue: await options.context(request),
                variableValues: parsed.variables,
                operationName: parsed.operationName,
            });
            sendJson(response, 200, result);
        } catch (error) {
            sendRequestError(response, 500, error instanceof Error ? error.message : "internal error");
        }
    };
}
