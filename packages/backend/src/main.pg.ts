/** The `pg` entry point: a server over an external Postgres. See docs/entrypoints.md. */
import * as pgRuntime from "pg";
import { ApiServer, PgSqlDriver, applySchema, createAppContext, seedMockData } from "infra";
import { routes } from "./routes.ts";
import { parseServerArgs } from "./args.pg.ts";

/** Read the flags, then serve over the pool `pg` builds. */
async function main(): Promise<void> {
    const options = parseServerArgs(process.argv.slice(2));
    const url = options.databaseUrl ?? process.env.DATABASE_URL;
    const driver = new PgSqlDriver(pgRuntime, url === undefined ? {} : { connectionString: url });
    if (options.schema) {
        await applySchema(driver);
    }
    if (options.seed) {
        await seedMockData(driver.createExecutor());
    }
    const app = createAppContext({ driver });
    const server = new ApiServer(app, routes);
    const port = await server.listen(options.port);
    console.log(`api listening on http://127.0.0.1:${port}${options.seed ? " (mock data seeded)" : ""}`);
}

await main();
