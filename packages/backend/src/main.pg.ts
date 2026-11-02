/** The `pg` entry point: a server over an external Postgres. See docs/entrypoints.md. */
import * as pgRuntime from "pg";
import { PgSqlDriver } from "infra";
import { parseServerArgs, startServer } from "./serve.ts";

/** Read the flags, then serve over the pool `pg` builds. */
async function main(): Promise<void> {
    const parsed = parseServerArgs(process.argv.slice(2));
    if (!parsed.ok) {
        console.error(parsed.message);
        process.exitCode = 1;
        return;
    }
    const { options } = parsed;
    const url = options.databaseUrl ?? process.env.DATABASE_URL;
    const driver = new PgSqlDriver(pgRuntime, url === undefined ? {} : { connectionString: url });
    const started = await startServer(driver, options);
    console.log(`api listening on http://127.0.0.1:${started.port}${options.seed ? " (mock data seeded)" : ""}`);
}

await main();
