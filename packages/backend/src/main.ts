/**
 * The backend entry point: run an API server, optionally seeded with mock data.
 * See docs/mockdata.md.
 *
 * Usage: `node src/main.ts [--port <n>] [--seed]`.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { pathToFileURL } from "node:url";
import type { PGlite } from "@electric-sql/pglite";
import { createApiServer } from "./http/server.ts";
import { seedMockData } from "./mock/seed.ts";
import { createPglite } from "./postgres/pglite-setup.ts";

/** The generated DDL, next to the driver setup. */
const SCHEMA_URL = new URL("./postgres/schema.sql", import.meta.url);

/** The port used when `--port` is absent. */
const DEFAULT_PORT = 3000;

/** A fresh in-memory database with the generated schema applied. */
export async function createDatabase(): Promise<PGlite> {
    const db = createPglite();
    await db.exec(readFileSync(SCHEMA_URL, "utf8"));
    return db;
}

/** Listen on `port`; `0` picks a free one. Resolves with the bound port. */
function listen(server: Server, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, () => {
            const address = server.address();
            resolve(typeof address === "object" && address !== null ? address.port : port);
        });
    });
}

/** How a server is started. */
export interface StartOptions {
    port?: number;
    seed?: boolean;
}

/** A running server and the database behind it. */
export interface StartedServer {
    server: Server;
    db: PGlite;
    port: number;
}

/** Build a database, optionally seed it, and start the API server. */
export async function startServer(options: StartOptions = {}): Promise<StartedServer> {
    const db = await createDatabase();
    if (options.seed) {
        await seedMockData(db);
    }
    const server = createApiServer(db);
    const port = await listen(server, options.port ?? DEFAULT_PORT);
    return { server, db, port };
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
    const started = await startServer(options);
    console.log(`api listening on http://127.0.0.1:${started.port}${options.seed ? " (mock data seeded)" : ""}`);
}
