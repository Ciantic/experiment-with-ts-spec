/**
 * The backend entry point: run an API server, optionally seeded with mock data.
 * See docs/mockdata.md and docs/rest-api-effect.md.
 *
 * Usage: `node src/main.ts [--port <n>] [--seed]`.
 *
 * Everything is built from Effect layers: `PgliteClient.layer` supplies the
 * `SqlClient` the generated repositories and reads require, and
 * `NodeHttpServer.layer` supplies the `HttpServer` the route table is served on.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Effect, Layer } from "effect";
import type { Scope } from "effect";
import { NodeHttpServer } from "@effect/platform-node";
import { PgliteClient } from "@effect/sql-pglite";
import type { SqlError } from "effect/sql/SqlError";
import type { ServeError } from "effect/http/HttpServerError";
import type { PGlite } from "@electric-sql/pglite";
import { serve } from "./http/server.ts";
import { seedMockData } from "./mock/seed.ts";
import { createPglite } from "./postgres/pglite-setup.ts";

/** The generated DDL, next to the driver setup. */
const SCHEMA_URL = new URL("./postgres/schema.sql", import.meta.url);

/** The port used when `--port` is absent. */
const DEFAULT_PORT = 3000;

/** The interface the server binds to. */
const HOST = "127.0.0.1";

/** A fresh in-memory database with the generated schema applied. */
export function createDatabase(): Effect.Effect<PGlite> {
    return Effect.gen(function* () {
        const db = createPglite();
        yield* Effect.tryPromise({
            try: () => db.exec(readFileSync(SCHEMA_URL, "utf8")),
            catch: (cause) => new Error(`applying schema.sql failed: ${String(cause)}`),
        }).pipe(Effect.orDie);
        return db;
    });
}

/** How a server is started. */
export interface StartOptions {
    port?: number;
    seed?: boolean;
}

/** A running server. The scope it was started in owns its lifetime. */
export interface StartedServer {
    port: number;
}

/**
 * Build a database, optionally seed it, and start the API server. The server runs
 * in the caller's scope: it is torn down when that scope closes, so callers wrap
 * this in `Effect.scoped`. `port: 0` binds a free port, reported back on the result.
 */
export function startServer(
    options: StartOptions = {},
): Effect.Effect<StartedServer, SqlError | ServeError, Scope.Scope> {
    return Effect.gen(function* () {
        const db = yield* createDatabase();
        const nodeServer = createServer();
        const requestedPort = options.port ?? DEFAULT_PORT;
        const context = yield* Layer.build(
            Layer.mergeAll(
                PgliteClient.layer({ liveClient: db }),
                NodeHttpServer.layer(() => nodeServer, { port: requestedPort, host: HOST }),
            ),
        );

        if (options.seed) {
            yield* seedMockData.pipe(Effect.provideContext(context));
        }
        yield* serve.pipe(Effect.provideContext(context), Effect.forkScoped);

        const address = nodeServer.address();
        const port = typeof address === "object" && address !== null ? address.port : requestedPort;
        return { port };
    });
}

/** Read `--port <n>` and `--seed` (alias `--mock`) from the command line. */
export function parseArgs(argv: string[]): StartOptions {
    const options: StartOptions = {};
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === "--seed" || arg === "--mock") {
            options.seed = true;
        } else if (arg === "--port") {
            const value = argv[index + 1];
            if (value === undefined || !Number.isInteger(Number(value))) {
                throw new Error("--port needs an integer");
            }
            options.port = Number(value);
            index += 1;
        }
    }
    return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    const options = parseArgs(process.argv.slice(2));
    const program = Effect.gen(function* () {
        const started = yield* startServer(options);
        yield* Effect.sync(() =>
            console.log(`api listening on http://${HOST}:${started.port}${options.seed ? " (mock data seeded)" : ""}`),
        );
        // Keep the scope open so the server keeps serving.
        yield* Effect.never;
    });
    await Effect.runPromise(Effect.scoped(program).pipe(Effect.orDie));
}
