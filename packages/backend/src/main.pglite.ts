/** The PGlite entry point: a server over an in-memory database, for development and tests. See docs/entrypoints.md. */
import { PGlite } from "@electric-sql/pglite";
import { ApiServer, PgliteSqlDriver, applySchema, createAppContext, seedMockData } from "infra";
import { routes } from "./http/routes/index.ts";
import { DEFAULT_PORT, parseServerArgs } from "./args.ts";

/** Read the flags, then serve over a fresh in-memory database. */
async function main(): Promise<void> {
    const parsed = parseServerArgs(process.argv.slice(2));
    if (!parsed.ok) {
        console.error(parsed.message);
        process.exitCode = 1;
        return;
    }
    const { options } = parsed;
    const driver = new PgliteSqlDriver(PGlite, {
        debug: options.logSql === true ? 1 : 0,
        ...(options.dataDir === undefined ? {} : { dataDir: options.dataDir }),
    });
    if (options.seed) {
        await applySchema(driver);
        await seedMockData(driver.createExecutor());
    }
    const app = createAppContext({ driver });
    const server = new ApiServer(app, routes);
    const port = await server.listen(options.port ?? DEFAULT_PORT);
    console.log(`api listening on http://127.0.0.1:${port}${options.seed ? " (mock data seeded)" : ""}`);
}

await main();
