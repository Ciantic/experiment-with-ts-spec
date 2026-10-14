/**
 * The Hono app over the generated route table, and the adapter that turns one call
 * into a response. See docs/rest-api.md.
 *
 * Hono owns matching: every call is registered on the verb and path the table
 * names. `POST /$group` is the one entry that is not a route — it carries a tree
 * of calls, each naming its operation id, and it is handled by the group handler
 * over the same table. See docs/transactions.md.
 */
import { parse as decode, stringify as encode } from "devalue";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { GROUP_PATH, handleGroup } from "./group-handler.ts";
import { error, statusFor, type HttpResponse } from "./http-response.ts";
import type { Route } from "./route.ts";
import { routes as generatedRoutes } from "./routes/index.ts";

/** The largest request body accepted, in bytes. */
const MAX_BODY_BYTES = 1_000_000;

/** Write a response: a success body is `devalue` text, a failure plain JSON. */
function send(context: Context, result: HttpResponse): Response {
    return context.body(result.body, result.status as ContentfulStatusCode, {
        "content-type": "application/json",
    });
}

/** The encoded argument one request carries, read from where the route says it travels. */
async function readArgument(route: Route, context: Context): Promise<string | undefined> {
    if (route.source === "query") {
        return context.req.query("q");
    }
    const body = await context.req.text();
    return body === "" ? undefined : body;
}

/** Decode, validate, call, and encode one request. Never throws. */
async function respond(db: SqlExecutor, route: Route, context: Context): Promise<Response> {
    const encoded = await readArgument(route, context);

    let value: unknown;
    try {
        value = encoded === undefined ? undefined : decode(encoded);
    } catch {
        return send(context, error(400, "malformed request"));
    }

    const parsed = route.input.safeParse(value);
    if (!parsed.success) {
        return send(context, {
            status: 400,
            body: JSON.stringify({ error: "invalid request", issues: parsed.error.issues }),
        });
    }

    try {
        const result = await route.handler(db, parsed.data);
        // A `get` miss and a void write both encode as `null`.
        return send(context, { status: 200, body: encode(result ?? null) });
    } catch (thrown) {
        const message = thrown instanceof Error ? thrown.message : "request failed";
        return send(context, error(statusFor(thrown), message));
    }
}

/** Register one call on the verb it uses, the way Hono's own API names them. */
function register(app: Hono, db: SqlExecutor, route: Route): void {
    const handler = (context: Context) => respond(db, route, context);
    switch (route.method) {
        case "GET":
            app.get(route.path, handler);
            return;
        case "POST":
            app.post(route.path, handler);
            return;
        case "PUT":
            app.put(route.path, handler);
            return;
        case "PATCH":
            app.patch(route.path, handler);
            return;
        case "DELETE":
            app.delete(route.path, handler);
            return;
    }
}

/** A Hono app exposing `table` over `db`; the table defaults to the generated one. */
export function createApiApp(db: SqlExecutor, table: Route[] = generatedRoutes): Hono {
    const app = new Hono();
    const byId = new Map(table.map((route) => [route.id, route]));

    // The cap is middleware, so the tree a group carries is bounded the way a write's body is.
    app.use(
        bodyLimit({
            maxSize: MAX_BODY_BYTES,
            onError: (context) => send(context, error(400, "request body too large")),
        }),
    );

    for (const route of table) {
        register(app, db, route);
    }

    // The group is the one entry not matched by a verb: it resolves the ids its tree names.
    app.post(GROUP_PATH, async (context) =>
        send(context, await handleGroup(db, (id) => byId.get(id), await context.req.text())),
    );

    app.notFound((context) => send(context, error(404, "no route")));
    return app;
}
