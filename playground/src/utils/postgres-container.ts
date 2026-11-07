/** Starts the playground's PostgreSQL container under Podman. */
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";

/** The container name a bare `startPostgres()` uses. */
const DEFAULT_NAME = "playground-postgres";

/** The loopback port a bare `startPostgres()` publishes. */
const DEFAULT_PORT = 5432;

/** The image a bare `startPostgres()` runs. */
const DEFAULT_IMAGE = "docker.io/library/postgres:18-alpine";

/** How long `startPostgres()` waits for PostgreSQL before giving up. */
const DEFAULT_READY_TIMEOUT_MS = 30_000;

/** The container `startPostgres()` started or reused. */
export interface PostgresContainer {
    /** The Podman container name. */
    name: string;
    /** The host port PostgreSQL is published on. */
    port: number;
    /** The connection string `PgSqlDriver` takes. */
    databaseUrl: string;
    /** False when an already running container was reused instead of started. */
    started: boolean;
    /** Stops the container this call started; a reused container is left running. */
    stop: () => Promise<void>;
}

/** How `startPostgres()` behaves. Every flag defaults to the value a test wants. */
export interface StartPostgresOptions {
    /** Container name. Defaults to `playground-postgres`. */
    name?: string;
    /** Loopback port to publish. Defaults to `5432`. */
    port?: number;
    /** Image to run. Defaults to `docker.io/library/postgres:18-alpine`. */
    image?: string;
    /** Reuse a running container, and start a stopped one instead of recreating it. Defaults to true. */
    onlyIfNotRunning?: boolean;
    /** Stop the container when the process exits, including on Ctrl+C. Defaults to false. */
    stopOnExit?: boolean;
    /** Wait until PostgreSQL accepts connections. Defaults to true. */
    waitForReady?: boolean;
    /** How long to wait for PostgreSQL. Defaults to 30000 ms. */
    readyTimeoutMs?: number;
}

interface ResolvedOptions {
    name: string;
    port: number;
    image: string;
    onlyIfNotRunning: boolean;
    stopOnExit: boolean;
    waitForReady: boolean;
    readyTimeoutMs: number;
}

interface PodmanResult {
    status: number;
    stdout: string;
    stderr: string;
}

/** The connection string for a published loopback port, with the trust authentication the container runs. */
function databaseUrl(port: number): string {
    return `postgres://postgres@127.0.0.1:${port}/postgres`;
}

function resolveOptions(options: StartPostgresOptions): ResolvedOptions {
    const port = options.port ?? DEFAULT_PORT;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`port must be an integer between 1 and 65535, got ${port}`);
    }
    return {
        name: options.name ?? DEFAULT_NAME,
        port,
        image: options.image ?? DEFAULT_IMAGE,
        onlyIfNotRunning: options.onlyIfNotRunning ?? true,
        stopOnExit: options.stopOnExit ?? false,
        waitForReady: options.waitForReady ?? true,
        readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
    };
}

function podman(args: string[]): PodmanResult {
    const result = spawnSync("podman", args, { encoding: "utf8" });
    if (result.error !== undefined) {
        throw new Error(`cannot run podman: ${result.error.message}`);
    }
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function exists(name: string): boolean {
    return podman(["container", "exists", name]).status === 0;
}

function isRunning(name: string): boolean {
    if (!exists(name)) {
        return false;
    }
    return podman(["inspect", "--format", "{{.State.Running}}", name]).stdout.trim() === "true";
}

/** The host port the container publishes, falling back to the requested one. */
function publishedPort(name: string, fallback: number): number {
    const result = podman(["port", name, "5432/tcp"]);
    if (result.status !== 0) {
        return fallback;
    }
    const first = result.stdout.split("\n")[0]?.trim();
    if (first === undefined || first === "") {
        return fallback;
    }
    const text = first.slice(first.lastIndexOf(":") + 1);
    return /^\d+$/.test(text) ? Number(text) : fallback;
}

function remove(name: string): void {
    const result = podman(["rm", "--force", "--ignore", name]);
    if (result.status !== 0) {
        throw new Error(`cannot remove Podman container ${name}: ${result.stderr.trim() || `exit code ${result.status}`}`);
    }
}

function runArgs(options: ResolvedOptions): string[] {
    return [
        "--rm",
        "--name",
        options.name,
        "-e",
        "POSTGRES_HOST_AUTH_METHOD=trust",
        "-p",
        `127.0.0.1:${options.port}:5432`,
        options.image,
    ];
}

async function acceptsConnections(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

/** Whether PostgreSQL itself accepts connections; Podman's port forwarder accepts TCP before it does. */
function isReadyInside(name: string): boolean {
    return podman(["exec", name, "pg_isready", "-U", "postgres", "-d", "postgres"]).status === 0;
}

async function waitForReady(name: string, port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const state = podman(["inspect", "--format", "{{.State.Running}}", name]);
        if (state.status === 0 && state.stdout.trim() !== "true") {
            throw new Error(`Podman container ${name} stopped before PostgreSQL became ready`);
        }
        if (isReadyInside(name) && (await acceptsConnections(port))) {
            return;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`PostgreSQL in ${name} did not accept connections within ${timeoutMs} ms`);
}

/** Stop the container when this process exits, then re-raise the signal so the exit status stays honest. */
function stopWhenProcessExits(name: string): void {
    const stop = (): void => {
        spawnSync("podman", ["stop", "--ignore", name], { stdio: "ignore" });
    };
    const onExit = (): void => {
        stop();
    };
    const onSignal = (signal: NodeJS.Signals): void => {
        stop();
        process.off("exit", onExit);
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        process.kill(process.pid, signal);
    };
    process.on("exit", onExit);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
}

/** Start PostgreSQL, or reuse it when it is already running and `onlyIfNotRunning` is true. */
export async function startPostgres(options: StartPostgresOptions = {}): Promise<PostgresContainer> {
    const resolved = resolveOptions(options);

    if (isRunning(resolved.name)) {
        if (resolved.onlyIfNotRunning) {
            const port = publishedPort(resolved.name, resolved.port);
            if (resolved.waitForReady) {
                await waitForReady(resolved.name, port, resolved.readyTimeoutMs);
            }
            return { name: resolved.name, port, databaseUrl: databaseUrl(port), started: false, stop: async () => {} };
        }
        remove(resolved.name);
    }

    if (exists(resolved.name)) {
        const result = podman(["start", resolved.name]);
        if (result.status !== 0) {
            throw new Error(`cannot start Podman container ${resolved.name}: ${result.stderr.trim() || `exit code ${result.status}`}`);
        }
    } else {
        const result = podman(["run", "--detach", ...runArgs(resolved)]);
        if (result.status !== 0) {
            throw new Error(`podman run failed: ${result.stderr.trim() || `exit code ${result.status}`}`);
        }
    }

    if (resolved.stopOnExit) {
        stopWhenProcessExits(resolved.name);
    }

    const port = publishedPort(resolved.name, resolved.port);
    if (resolved.waitForReady) {
        try {
            await waitForReady(resolved.name, port, resolved.readyTimeoutMs);
        } catch (thrown) {
            remove(resolved.name);
            throw thrown;
        }
    }

    return {
        name: resolved.name,
        port,
        databaseUrl: databaseUrl(port),
        started: true,
        stop: async () => {
            podman(["stop", "--ignore", resolved.name]);
        },
    };
}
