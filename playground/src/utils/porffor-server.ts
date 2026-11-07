/** The Porffor environment: the backend bundle under `porf`, over a database on the playground's Podman container. */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ApiClient } from "sdk/http.ts";
import type { Examples, PlaygroundServer } from "./environment.ts";
import { runWith } from "./environment.ts";
import { startPostgres } from "./postgres-container.ts";
import { createDatabase, dropDatabase } from "./postgres-server.ts";

/** The workspace root, which the bundle is built from. */
const WORKSPACE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** The bundle the Porffor entry point produces. */
const PORFFOR_BUNDLE = fileURLToPath(
    new URL("../../../packages/backend/dist.porffor/main.porffor.js", import.meta.url),
);

/** How long `porf` may take to report that it is listening. */
const START_TIMEOUT_MS = 120_000;

/** A loopback port nothing listens on, for a server that takes its port as an argument. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });
}

/** Build the Porffor bundle, which is written beside the backend's other builds. */
function buildPorfforBundle(): void {
    const result = spawnSync("pnpm", ["--filter", "backend", "run", "build:porffor"], {
        cwd: WORKSPACE_ROOT,
        encoding: "utf8",
    });
    if (result.error !== undefined) {
        throw new Error(`cannot run pnpm: ${result.error.message}`);
    }
    if (result.status !== 0) {
        throw new Error(`build:porffor failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
    }
}

/** Resolve once the child prints the line its entry point logs when the server is listening. */
function waitForListening(child: ChildProcess, output: () => string): Promise<void> {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + START_TIMEOUT_MS;
        const onExit = (code: number | null): void => {
            settle(new Error(`the Porffor server exited with ${code}:\n${output()}`));
        };
        const settle = (thrown?: Error): void => {
            clearInterval(poll);
            child.off("exit", onExit);
            if (thrown === undefined) {
                resolve();
            } else {
                reject(thrown);
            }
        };
        const poll = setInterval(() => {
            if (output().includes("api listening")) {
                settle();
            } else if (Date.now() > deadline) {
                settle(new Error(`the Porffor server did not start within ${START_TIMEOUT_MS} ms:\n${output()}`));
            }
        }, 100);
        child.once("exit", onExit);
    });
}

/** Stop the child, escalating to `SIGKILL` when it ignores the polite signal. */
async function stopChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) {
        return;
    }
    const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
    });
    child.kill("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
        exited.then(() => false),
        new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(true), 5000);
        }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
        child.kill("SIGKILL");
        await exited;
    }
}

/** Build, then run the bundle against a freshly created database on the playground's container. */
export async function startPorfforServer(): Promise<PlaygroundServer> {
    const container = await startPostgres({ onlyIfNotRunning: true });
    const databaseUrl = await createDatabase(container, "playground_porffor");
    buildPorfforBundle();

    const port = await freePort();
    const child = spawn(
        "porf",
        [PORFFOR_BUNDLE, "--schema", "--seed", "--without-auth", "--database-url", databaseUrl, "--port", String(port)],
        { stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
    });

    try {
        await waitForListening(child, () => output);
    } catch (thrown) {
        await stopChild(child);
        await dropDatabase(container, databaseUrl);
        await container.stop();
        throw thrown;
    }

    return {
        http: new ApiClient(`http://127.0.0.1:${port}`),
        close: async () => {
            await stopChild(child);
            await dropDatabase(container, databaseUrl);
            await container.stop();
        },
    };
}

/** The Porffor environment as a describe body. */
export function runWithPorffor(examples: Examples): () => void {
    return runWith(startPorfforServer, examples);
}
