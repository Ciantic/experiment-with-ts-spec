/** The hand-written request handler: decode, check, run, and encode. See docs/rest-api.md and docs/transactions.md. */
import { parse as decode, stringify as encode } from "devalue";
import { attempt, batch, transaction } from "../db/group.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";

/** The verbs the route table uses. */
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** The part of a schema the router uses, structurally, so the router couples to no Zod version. */
export interface RouteInput {
    safeParse(
        value: unknown,
    ): { success: true; data: unknown } | { success: false; error: { issues: unknown } };
}

/** One exposed call. `routes.ts` is generated against this shape. */
export interface Route {
    method: HttpMethod;
    path: string;
    /** Whether the call carries its argument in `q` or in the request body. */
    source: "query" | "body";
    /** Validates the decoded argument. */
    input: RouteInput;
    /** Runs the call; it receives the request's `SqlExecutor` and may open a boundary. See docs/transactions.md. */
    handler: (db: SqlExecutor, argument: unknown) => Promise<unknown>;
}

/** One request, with the body already read into a string. */
export interface HttpRequest {
    method: string;
    /** The path and query string, e.g. `/invoice/query?q=…`. */
    url: string;
    body: string;
}

/** One response. Success bodies are `devalue`; error bodies are plain JSON. */
export interface HttpResponse {
    status: number;
    body: string;
}

/** The path the group entry point is mounted at. See docs/transactions.md. */
export const GROUP_PATH = "/$group";

/** Whether a group runs its calls as one boundary. */
type GroupKind = "batch" | "transaction" | "attempt";

/** A checked call: its route, and the argument that route's schema accepted. */
interface PlannedCall {
    kind: "call";
    route: Route;
    argument: unknown;
}

/** A checked group, with every call in it resolved and validated. */
interface PlannedGroup {
    kind: GroupKind;
    calls: Planned[];
}

type Planned = PlannedCall | PlannedGroup;

/** A group body the router refuses, naming the entry that is wrong. */
class BadGroup extends Error {
    readonly path: number[];
    readonly issues: unknown;

    constructor(message: string, path: number[], issues?: unknown) {
        super(message);
        this.path = path;
        this.issues = issues;
    }
}

/** A handler that failed inside a group, carrying the path of the entry that raised. */
class GroupFailure extends Error {
    readonly path: number[];
    readonly code: unknown;

    constructor(thrown: unknown, path: number[]) {
        super(thrown instanceof Error ? thrown.message : "request failed");
        this.path = path;
        this.code = (thrown as { code?: unknown } | null)?.code;
    }
}

/** PostgreSQL error codes to HTTP statuses. Anything else is a server fault. */
const ERROR_STATUSES: Record<string, number> = {
    "22P02": 400, // invalid_text_representation
    "23502": 400, // not_null_violation
    "23503": 409, // foreign_key_violation
    "23505": 409, // unique_violation
    "23514": 400, // check_violation: a value the row's constraints reject
    "40001": 409, // serialization_failure: the version-conflict raise. See docs/versioning.md
};

/** Every verb a route or a group entry may name. */
const METHODS: HttpMethod[] = ["GET", "POST", "PATCH", "DELETE"];

/** The status a thrown database error maps to. */
function statusFor(thrown: unknown): number {
    const code = (thrown as { code?: unknown }).code;
    if (typeof code !== "string") {
        return 500;
    }
    return ERROR_STATUSES[code] ?? 500;
}

/** A plain-JSON error body, so a failure is readable without the codec. */
function error(status: number, message: string): HttpResponse {
    return { status, body: JSON.stringify({ error: message }) };
}

/** The same, for a group failure: the path names the entry that raised. */
function failure(status: number, message: string, path: number[], issues?: unknown): HttpResponse {
    const body: Record<string, unknown> = { error: message, path };
    if (issues !== undefined) {
        body["issues"] = issues;
    }
    return { status, body: JSON.stringify(body) };
}

/** Whether a decoded value is an object with keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Whether a decoded value is one of the verbs. */
function isMethod(value: unknown): value is HttpMethod {
    return typeof value === "string" && (METHODS as string[]).includes(value);
}

/** Check one node of a group body: its shape, then the route it names, then that route's `input`. */
function planNode(wire: unknown, byKey: Map<string, Route>, path: number[]): Planned {
    if (!isRecord(wire)) {
        throw new BadGroup("a group entry must be an object", path);
    }

    if ("call" in wire) {
        return planCall(wire["call"], byKey, path);
    }

    if ("group" in wire) {
        const group = wire["group"];
        if (!isRecord(group)) {
            throw new BadGroup("a group must be an object", path);
        }
        const kind = group["kind"];
        if (kind !== "batch" && kind !== "transaction" && kind !== "attempt") {
            throw new BadGroup("a group kind must be batch, transaction, or attempt", path);
        }
        const calls = group["calls"];
        if (!Array.isArray(calls)) {
            throw new BadGroup("a group must carry calls", path);
        }
        return { kind, calls: calls.map((child, index) => planNode(child, byKey, [...path, index])) };
    }

    throw new BadGroup("a group entry must be a call or a group", path);
}

/** Resolve one call against the route table and validate its argument. */
function planCall(value: unknown, byKey: Map<string, Route>, path: number[]): PlannedCall {
    if (!isRecord(value)) {
        throw new BadGroup("a call must be an object", path);
    }
    const method = value["method"];
    const routePath = value["path"];
    if (!isMethod(method)) {
        throw new BadGroup("a call names an unknown method", path);
    }
    if (typeof routePath !== "string") {
        throw new BadGroup("a call must name a path", path);
    }

    const route = byKey.get(`${method} ${routePath}`);
    if (!route) {
        throw new BadGroup("no route", path);
    }

    const parsed = route.input.safeParse(value["argument"]);
    if (!parsed.success) {
        throw new BadGroup("invalid request", path, parsed.error.issues);
    }

    return { kind: "call", route, argument: parsed.data };
}

/** Check a whole group body. The top level must be a group, not a lone call. */
function planGroup(value: unknown, byKey: Map<string, Route>): PlannedGroup {
    const node = planNode(value, byKey, []);
    if (node.kind === "call") {
        throw new BadGroup("the body must be a group", []);
    }
    return node;
}

/** Run one checked node on the boundary its `SqlExecutor` already carries. See docs/transactions.md. */
async function execute(db: SqlExecutor, node: Planned, path: number[]): Promise<unknown> {
    try {
        return await runNode(db, node, path);
    } catch (thrown) {
        // The innermost entry wins, so the path names the call that actually raised.
        throw thrown instanceof GroupFailure ? thrown : new GroupFailure(thrown, path);
    }
}

/** Whether `path` is the same node as `ancestor`, or beneath it. */
function within(path: number[], ancestor: number[]): boolean {
    return path.length >= ancestor.length && ancestor.every((step, index) => path[index] === step);
}

/** The body of {@link execute}, without the path bookkeeping. */
async function runNode(db: SqlExecutor, node: Planned, path: number[]): Promise<unknown> {
    if (node.kind === "call") {
        const result = await node.route.handler(db, node.argument);
        return result ?? null;
    }

    // A step runs on whatever `SqlExecutor` its group's boundary hands it; `db/group.ts` owns that handoff.
    const steps = node.calls.map(
        (child, index) => async (inner: SqlExecutor) => await execute(inner, child, [...path, index]),
    );

    if (node.kind === "batch") {
        return await batch(db, ...steps);
    }

    if (node.kind === "transaction") {
        return await transaction(db, ...steps);
    }

    const outcome = await attempt(db, ...steps);
    if (outcome.ok) {
        return { ok: true, value: outcome.value };
    }
    // A failure that is not a group failure came from outside the tree, so it is nobody's to report.
    if (!(outcome.error instanceof GroupFailure) || !within(outcome.error.path, path)) {
        throw outcome.error;
    }
    return { ok: false, error: { message: outcome.error.message, path: outcome.error.path } };
}

/** A router over a route table, reusing one `db` for every call. */
export function createRouter(db: SqlExecutor, routes: Route[]) {
    const byKey = new Map(routes.map((route) => [`${route.method} ${route.path}`, route]));

    /** Decode, check, run, and encode a tree of calls. */
    async function handleGroup(body: string): Promise<HttpResponse> {
        let value: unknown;
        try {
            value = body === "" ? undefined : decode(body);
        } catch {
            return error(400, "malformed request");
        }

        let planned: PlannedGroup;
        try {
            planned = planGroup(value, byKey);
        } catch (thrown) {
            if (!(thrown instanceof BadGroup)) {
                throw thrown;
            }
            return failure(400, thrown.message, thrown.path, thrown.issues);
        }

        try {
            return { status: 200, body: encode(await execute(db, planned, [])) };
        } catch (thrown) {
            if (thrown instanceof GroupFailure) {
                return failure(statusFor(thrown), thrown.message, thrown.path);
            }
            const message = thrown instanceof Error ? thrown.message : "request failed";
            return error(statusFor(thrown), message);
        }
    }

    return {
        /** Match, decode, validate, call, and encode one request. Never throws. */
        async handle(request: HttpRequest): Promise<HttpResponse> {
            const url = new URL(request.url, "http://localhost");
            if (request.method === "POST" && url.pathname === GROUP_PATH) {
                return await handleGroup(request.body);
            }

            const route = byKey.get(`${request.method} ${url.pathname}`);
            if (!route) {
                return error(404, "no route");
            }

            // A `query` call carries its argument in `q`; a `body` call in the request body.
            const encoded =
                route.source === "query"
                    ? (url.searchParams.get("q") ?? undefined)
                    : request.body === ""
                        ? undefined
                        : request.body;

            let value: unknown;
            try {
                value = encoded === undefined ? undefined : decode(encoded);
            } catch {
                return error(400, "malformed request");
            }

            const parsed = route.input.safeParse(value);
            if (!parsed.success) {
                return {
                    status: 400,
                    body: JSON.stringify({ error: "invalid request", issues: parsed.error.issues }),
                };
            }

            try {
                const result = await route.handler(db, parsed.data);
                // A `get` miss and a void write both encode as `null`.
                return { status: 200, body: encode(result ?? null) };
            } catch (thrown) {
                const message = thrown instanceof Error ? thrown.message : "request failed";
                return error(statusFor(thrown), message);
            }
        },
    };
}
