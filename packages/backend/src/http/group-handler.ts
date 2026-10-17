/** The group entry point: check a tree of calls, run it on the boundary its kind names, and encode the results. See docs/transactions.md. */
import { parse as decode, stringify as encode } from "devalue";
import { attempt, attemptWith, batch, transaction, transactionWith } from "../db/group.ts";
import {
    ACCESS_MODES,
    ISOLATION_LEVELS,
    type SqlExecutor,
    type TransactionOptions,
} from "../db/sql-executor.ts";
import { AppError, BadGroupError, RequestError } from "validation/errors.ts";
import { errorFrom, statusFor, type HttpResponse } from "./http-response.ts";
import type { Route } from "./router.ts";

/** The path the group entry point is mounted at. See docs/rest-api.md. */
export const GROUP_PATH = "/$group";

/** How one `call` of a group body is resolved: the route that serves its id, or `undefined`. */
export type ResolveRoute = (id: string) => Route | undefined;

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
    /** The modes the group opens its boundary with, or `undefined` for the session defaults. */
    options: TransactionOptions | undefined;
    calls: Planned[];
}

type Planned = PlannedCall | PlannedGroup;

/** A handler that failed inside a group, carrying the path of the entry that raised. */
class GroupFailure extends AppError {
    declare readonly path: number[];

    constructor(thrown: unknown, path: number[]) {
        const kind = thrown instanceof AppError ? thrown.kind : undefined;
        super(
            thrown instanceof Error ? thrown.message : "request failed",
            { ...(kind === undefined ? {} : { kind }), status: statusFor(thrown) },
            { cause: thrown, path, issues: thrown instanceof AppError ? thrown.issues : undefined },
        );
    }
}

/** Whether a decoded value is an object with keys. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Whether a decoded value is one of the literals `values` names. */
function isOneOf<T extends string>(values: readonly T[], value: unknown): boolean {
    return typeof value === "string" && (values as readonly string[]).includes(value);
}

/** The literals one mode accepts, spelled for a refusal. */
function spell(values: readonly string[]): string {
    const last = values.at(-1) ?? "";
    return values.length <= 1 ? last : `${values.slice(0, -1).join(", ")}, or ${last}`;
}

/**
 * One mode of a group's options, refused unless it is a literal the port writes into its `begin`.
 * @throws {BadGroupError} when the value is not one of the literals the mode accepts
 */
function literal<T extends string>(values: readonly T[], value: unknown, what: string, path: number[]): T {
    if (!isOneOf(values, value)) {
        throw new BadGroupError(`${what} must be ${spell(values)}`, { path });
    }
    return value as T;
}

/**
 * Whether the value is the boolean a mode takes.
 * @throws {BadGroupError} when the value is not a boolean
 */
function flag(value: unknown, what: string, path: number[]): boolean {
    if (typeof value !== "boolean") {
        throw new BadGroupError(`${what} must be true or false`, { path });
    }
    return value;
}

/**
 * Check the modes a group names; only a group that opens a root boundary takes any.
 * @throws {BadGroupError} when a batch or a nested group names options, or a mode is not an object or one of the accepted keys
 */
function planOptions(
    wire: unknown,
    kind: GroupKind,
    inBoundary: boolean,
    path: number[],
): TransactionOptions | undefined {
    if (wire === undefined) {
        return undefined;
    }
    if (kind === "batch") {
        throw new BadGroupError("a batch opens no boundary, so it takes no transaction options", { path });
    }
    if (inBoundary) {
        throw new BadGroupError("a nested boundary is a savepoint, which takes no transaction options", { path });
    }
    if (!isRecord(wire)) {
        throw new BadGroupError("transaction options must be an object", { path });
    }
    for (const key of Object.keys(wire)) {
        if (key !== "isolationLevel" && key !== "accessMode" && key !== "deferrable") {
            throw new BadGroupError(`a transaction option must be isolationLevel, accessMode, or deferrable, not ${key}`, { path });
        }
    }

    // Each mode is written into the `begin`, so a value is one of the literals the port accepts rather than free text.
    const isolationLevel = wire["isolationLevel"];
    const accessMode = wire["accessMode"];
    const deferrable = wire["deferrable"];
    return {
        ...(isolationLevel === undefined
            ? {}
            : { isolationLevel: literal(ISOLATION_LEVELS, isolationLevel, "an isolation level", path) }),
        ...(accessMode === undefined ? {} : { accessMode: literal(ACCESS_MODES, accessMode, "an access mode", path) }),
        ...(deferrable === undefined ? {} : { deferrable: flag(deferrable, "deferrable", path) }),
    };
}

/**
 * Check one node of a group body: its shape, then the call it names, then that call's `input`.
 * @throws {BadGroupError} when the node is neither a call nor a group, or a group has no kind or calls
 */
function planNode(wire: unknown, resolve: ResolveRoute, path: number[], inBoundary: boolean): Planned {
    if (!isRecord(wire)) {
        throw new BadGroupError("a group entry must be an object", { path });
    }

    if ("call" in wire) {
        return planCall(wire["call"], resolve, path);
    }

    if ("group" in wire) {
        const group = wire["group"];
        if (!isRecord(group)) {
            throw new BadGroupError("a group must be an object", { path });
        }
        const kind = group["kind"];
        if (kind !== "batch" && kind !== "transaction" && kind !== "attempt") {
            throw new BadGroupError("a group kind must be batch, transaction, or attempt", { path });
        }
        const calls = group["calls"];
        if (!Array.isArray(calls)) {
            throw new BadGroupError("a group must carry calls", { path });
        }
        const options = planOptions(group["options"], kind, inBoundary, path);
        // A transaction or an attempt opens a boundary, so its own calls are inside one.
        const enclosing = inBoundary || kind !== "batch";
        return {
            kind,
            options,
            calls: calls.map((child, index) => planNode(child, resolve, [...path, index], enclosing)),
        };
    }

    throw new BadGroupError("a group entry must be a call or a group", { path });
}

/**
 * Resolve one call against the route table by the id it names, and validate its argument.
 * @throws {BadGroupError} when the call names no operation, or its argument fails the route's schema
 */
function planCall(value: unknown, resolve: ResolveRoute, path: number[]): PlannedCall {
    if (!isRecord(value)) {
        throw new BadGroupError("a call must be an object", { path });
    }
    const id = value["operation"];
    if (typeof id !== "string") {
        throw new BadGroupError("a call must name an operation", { path });
    }

    const route = resolve(id);
    if (!route) {
        throw new BadGroupError(`no operation \`${id}\``, { path });
    }

    const parsed = route.input.safeParse(value["argument"]);
    if (!parsed.success) {
        throw new BadGroupError("invalid request", { path, issues: parsed.error.issues });
    }

    return { kind: "call", route, argument: parsed.data };
}

/**
 * Check a whole group body. The top level must be a group, not a lone call.
 * @throws {BadGroupError} when the body is a lone call or a malformed group
 */
function planGroup(value: unknown, resolve: ResolveRoute): PlannedGroup {
    const node = planNode(value, resolve, [], false);
    if (node.kind === "call") {
        throw new BadGroupError("the body must be a group", { path: [] });
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

    // The modes a group named ride on the `begin` that opens it; a nested boundary is a savepoint and names none.
    if (node.kind === "transaction") {
        return node.options === undefined
            ? await transaction(db, ...steps)
            : await transactionWith(db, node.options, ...steps);
    }

    const outcome =
        node.options === undefined ? await attempt(db, ...steps) : await attemptWith(db, node.options, ...steps);
    if (outcome.ok) {
        return { ok: true, value: outcome.value };
    }
    // A failure that is not a group failure came from outside the tree, so it is nobody's to report.
    if (!(outcome.error instanceof GroupFailure) || !within(outcome.error.path, path)) {
        throw outcome.error;
    }
    const kind = outcome.error.kind;
    return {
        ok: false,
        error: {
            message: outcome.error.message,
            path: outcome.error.path,
            ...(kind === undefined ? {} : { kind }),
        },
    };
}

/** Decode, check, run, and encode a tree of calls. */
export async function handleGroup(db: SqlExecutor, resolve: ResolveRoute, body: string): Promise<HttpResponse> {
    let value: unknown;
    try {
        value = body === "" ? undefined : decode(body);
    } catch {
        return errorFrom(new RequestError("malformed request"));
    }

    let planned: PlannedGroup;
    try {
        planned = planGroup(value, resolve);
    } catch (thrown) {
        if (!(thrown instanceof BadGroupError)) {
            throw thrown;
        }
        return errorFrom(thrown);
    }

    try {
        return { status: 200, body: encode(await execute(db, planned, [])) };
    } catch (thrown) {
        return errorFrom(thrown);
    }
}
