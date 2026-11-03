/** Driver-agnostic command line reading shared by the entries. See docs/entrypoints.md. */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** The port used when `--port` is absent. */
export const DEFAULT_PORT = 3000;

/** The flags a server starts with. */
export interface ServerOptions {
    port?: number;
    seed?: boolean;
}

/** The flags an entry reads; the last three belong to a driver, so a server ignores them. */
export interface CliOptions extends ServerOptions {
    logSql?: boolean;
    databaseUrl?: string;
    dataDir?: string;
}

/** The shared flags, so `parseArgs` rejects anything it does not know. */
const CLI_FLAGS = {
    port: { type: "string" },
    seed: { type: "boolean" },
    mock: { type: "boolean" },
    "log-sql": { type: "boolean" },
    "database-url": { type: "string" },
    "data-dir": { type: "string" },
} as const satisfies ParseArgsOptionsConfig;

/** What reading the command line answered: the flags, or the message an entry prints before exiting. */
export type ParseResult =
    | { ok: true; options: CliOptions }
    | { ok: false; message: string };

/** Read `--port <n>`, `--seed` (alias `--mock`), `--log-sql`, `--database-url <url>`, and `--data-dir <path>`. */
export function parseServerArgs(argv: readonly string[]): ParseResult {
    let values;
    try {
        ({ values } = parseArgs({ args: argv, options: CLI_FLAGS, strict: true, allowPositionals: false }));
    } catch (thrown) {
        return { ok: false, message: thrown instanceof Error ? thrown.message : String(thrown) };
    }
    const options: CliOptions = {};
    if (values.seed === true || values.mock === true) {
        options.seed = true;
    }
    const port = values.port;
    if (port !== undefined) {
        if (!/^\d+$/.test(port)) {
            return { ok: false, message: "--port needs an integer" };
        }
        options.port = Number(port);
    }
    if (values["log-sql"] === true) {
        options.logSql = true;
    }
    const databaseUrl = values["database-url"];
    if (databaseUrl !== undefined) {
        options.databaseUrl = databaseUrl;
    }
    const dataDir = values["data-dir"];
    if (dataDir !== undefined) {
        options.dataDir = dataDir;
    }
    return { ok: true, options };
}
