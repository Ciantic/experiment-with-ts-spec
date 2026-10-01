/**
 * An `effect/http` server over the generated route table. See docs/rest-api-effect.md.
 *
 * Deliberately thin: it hands the request to the router through
 * `HttpServer.serveEffect`, which supplies the request service for each call.
 * Every decision about a call lives in the router or in the generated table.
 * `main.ts` provides the `HttpServer` (Node) and `SqlClient` layers.
 */
import * as HttpServer from "effect/http/HttpServer";
import { routes } from "./routes.ts";
import { createRouter } from "./router.ts";

/** A server exposing the generated route table. Requires the HTTP server and a `SqlClient`. */
export const serve = HttpServer.serveEffect(createRouter(routes));
