/** The real PostgreSQL environment: a database on the playground's Podman container, served by this process. */
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import * as pgRuntime from "pg";
import { ApiServer, PgSqlDriver, applySchema, createAppContext, seedMockData } from "infra";
import * as api from "sdk/api/index.ts";
import { exec } from "sdk/client.ts";
import { ApiClient } from "sdk/http.ts";
import { routes, withoutGuards } from "../../../packages/backend/src/routes.ts";
import type { Examples, PlaygroundServer } from "./environment.ts";
import { runWith } from "./environment.ts";
import { startPostgres, type PostgresContainer } from "./postgres-container.ts";

/** A server this process serves over one database. */
interface LocalServer {
    http: ApiClient;
    close: () => Promise<void>;
}

/** A connection string onto another database of the same server. */
function withDatabase(url: string, database: string): string {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    return parsed.toString();
}

/** Create a database for one run, so a long-lived container never carries a previous run's rows. */
export async function createDatabase(container: PostgresContainer, prefix: string): Promise<string> {
    const database = `${prefix}_${randomBytes(4).toString("hex")}`;
    const admin = new PgSqlDriver(pgRuntime, { connectionString: container.databaseUrl });
    try {
        await admin.exec(`create database "${database}"`);
    } finally {
        await admin.close();
    }
    return withDatabase(container.databaseUrl, database);
}

/** Drop a database this run created, releasing the connections that still use it. */
export async function dropDatabase(container: PostgresContainer, url: string): Promise<void> {
    const database = new URL(url).pathname.slice(1);
    const admin = new PgSqlDriver(pgRuntime, { connectionString: container.databaseUrl });
    try {
        await admin.exec(`drop database if exists "${database}" with (force)`);
    } finally {
        await admin.close();
    }
}

/** Apply the generated schema and the mock data, unless the database already holds the schema. */
async function prepare(driver: PgSqlDriver): Promise<void> {
    const result = await driver.query<{ tables: number }>(
        "select count(*)::int as tables from information_schema.tables where table_schema = 'public'",
    );
    if ((result.rows[0]?.tables ?? 0) > 0) {
        return;
    }
    await applySchema(driver);
    await seedMockData(driver.createExecutor());
}

/** Serve one database over an ephemeral port; the returned close releases only this process's server and pool. */
async function serve(databaseUrl: string): Promise<LocalServer> {
    const driver = new PgSqlDriver(pgRuntime, { connectionString: databaseUrl });
    await prepare(driver);
    const server = new ApiServer(createAppContext({ driver }), withoutGuards(routes));
    const port = await server.listen(0);
    return {
        http: new ApiClient(`http://127.0.0.1:${port}`),
        close: async () => {
            await server.close();
            await driver.close();
        },
    };
}

/** Serve a freshly created database, and remove both the database and the container afterwards. */
export async function startPostgresServer(): Promise<PlaygroundServer> {
    const container = await startPostgres({ onlyIfNotRunning: true });
    const databaseUrl = await createDatabase(container, "playground_pg");
    const server = await serve(databaseUrl);
    return {
        http: server.http,
        close: async () => {
            await server.close();
            await dropDatabase(container, databaseUrl);
            await container.stop();
        },
    };
}

/**
 * Start the container and serve its default database, leaving both ready for a backend you start yourself.
 * The container outlives the run, so the next press reuses it and the rows it already holds.
 */
export async function startPostgresContainer(): Promise<PlaygroundServer> {
    const container = await startPostgres({ onlyIfNotRunning: true });
    const server = await serve(container.databaseUrl);
    console.log(`PostgreSQL container "${container.name}" is left running at ${container.databaseUrl}`);
    return { http: server.http, close: server.close };
}

/** The real PostgreSQL environment as a describe body. */
export function runWithPostgres(examples: Examples): () => void {
    return runWith(startPostgresServer, examples);
}

/** The container left running after the run, as a describe body: one test asserts it serves the seeded database. */
export function runWithPostgresContainer(): () => void {
    return runWith(startPostgresContainer, (getHttp) => {
        it("leaves the PostgreSQL container running", async () => {
            const [tenant] = await exec(getHttp(), api.queryTenant({ limit: 1, select: { id: true } }));
            expect(tenant).toBeDefined();
        });
    });
}

