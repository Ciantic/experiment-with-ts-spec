/** The command line the `pg` entry reads, a server over an external Postgres. See docs/entrypoints.md. */
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

/** The port used when `--port` is absent. */
const DEFAULT_PORT = 3000;

/** The flags the `pg` entry reads, with the port always resolved. */
interface CliOptions {
    port: number;
    schema?: boolean;
    seed?: boolean;
    databaseUrl?: string;
}

/** The usage text `--help` and `-h` print. */
export const HELP = [
    "Usage: <pg entry point> [options]",
    "",
    "Options:",
    "  --port <n>             port to listen on (default 3000)",
    "  --schema               apply the generated schema before serving",
    "  --seed                 insert the mock data before serving",
    "  --database-url <url>   Postgres connection string (defaults to DATABASE_URL)",
    "  --help, -h             print this help",
].join("\n");

/** The flags, so `parseArgs` rejects anything it does not know. */
const CLI_FLAGS = {
    port: { type: "string" },
    schema: { type: "boolean" },
    seed: { type: "boolean" },
    "database-url": { type: "string" },
    help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsOptionsConfig;

/** Read the flags, printing the help or the bad command line's message and exiting instead of returning. */
export function parseServerArgs(argv: readonly string[]): CliOptions {
    let values;
    try {
        ({ values } = parseArgs({ args: argv, options: CLI_FLAGS, strict: true, allowPositionals: false }));
    } catch (thrown) {
        console.error(thrown instanceof Error ? thrown.message : String(thrown));
        process.exit(1);
    }
    if (values.help === true) {
        console.log(HELP);
        process.exit(0);
    }
    const options: CliOptions = { port: DEFAULT_PORT };
    if (values.schema === true) {
        options.schema = true;
    }
    if (values.seed === true) {
        options.seed = true;
    }
    const port = values.port;
    if (port !== undefined) {
        if (!/^\d+$/.test(port)) {
            console.error("--port needs an integer");
            process.exit(1);
        }
        options.port = Number(port);
    }
    const databaseUrl = values["database-url"];
    if (databaseUrl !== undefined) {
        options.databaseUrl = databaseUrl;
    }
    return options;
}
