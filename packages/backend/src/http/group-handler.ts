/** The group entry point: check a tree of calls, run it on the boundary its kind names, and encode the results. See docs/transactions.md. */
import { parse as decode, stringify as encode } from "devalue";
import { attempt, batch, transaction } from "../db/group.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { error, failure, statusFor, type HttpResponse } from "./http-response.ts";
import type { HttpMethod, Route } from "./router.ts";

/** The path the group entry point is mounted at. See docs/rest-api.md. */
export const GROUP_PATH = "/$group";

/** How one `call` of a group body is resolved: the route that serves it, or `undefined`. */
export type ResolveRoute = (method: string, path: string) => Route | undefined;

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

/** A group body the handler refuses, naming the entry that is wrong. */
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

/** Every verb a group entry may name. */
const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

/** Whether a decoded value is an object with keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Whether a decoded value is one of the verbs. */
function isMethod(value: unknown): value is HttpMethod {
    return typeof value === "string" && (METHODS as string[]).includes(value);
}

/** Check one node of a group body: its shape, then the route it names, then that route's `input`. */
function planNode(wire: unknown, resolve: ResolveRoute, path: number[]): Planned {
    if (!isRecord(wire)) {
        throw new BadGroup("a group entry must be an object", path);
    }

    if ("call" in wire) {
        return planCall(wire["call"], resolve, path);
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
        return { kind, calls: calls.map((child, index) => planNode(child, resolve, [...path, index])) };
    }

    throw new BadGroup("a group entry must be a call or a group", path);
}

/** Resolve one call against the route table and validate its argument. */
function planCall(value: unknown, resolve: ResolveRoute, path: number[]): PlannedCall {
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

    const route = resolve(method, routePath);
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
function planGroup(value: unknown, resolve: ResolveRoute): PlannedGroup {
    const node = planNode(value, resolve, []);
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

/** Decode, check, run, and encode a tree of calls. */
export async function handleGroup(db: SqlExecutor, resolve: ResolveRoute, body: string): Promise<HttpResponse> {
    let value: unknown;
    try {
        value = body === "" ? undefined : decode(body);
    } catch {
        return error(400, "malformed request");
    }

    let planned: PlannedGroup;
    try {
        planned = planGroup(value, resolve);
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
