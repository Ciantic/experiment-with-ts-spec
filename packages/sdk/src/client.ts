/** The hand-written half of the client's call model: builders, combinators, and `exec`. See docs/transactions.md. */
import type { HttpClient } from "./http.ts";

/** The verbs a call may name. Declared here so the client imports no backend type. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** Whether a group runs its calls as one boundary, and whether it tolerates failure. */
export type GroupKind = "batch" | "transaction" | "attempt";

/** The modes a boundary-opening group is opened with. Declared here so the client imports no backend type. */
export interface TransactionOptions {
    readonly isolationLevel?: "serializable" | "repeatable read" | "read committed" | "read uncommitted";
    readonly accessMode?: "read write" | "read only";
    readonly deferrable?: boolean;
}

declare const Result: unique symbol;

/** One call, built by a generated function and not yet sent. */
export interface Call<R> {
    readonly kind: "call";
    /** The operation the server calls it by, e.g. `queryInvoice`: a group entry names this. */
    readonly operation: string;
    readonly method: Method;
    readonly path: string;
    readonly argument: unknown;
    readonly [Result]?: R;
}

/** Several calls in one request; `kind` decides the boundary. See docs/transactions.md. */
export interface Group<R> {
    readonly kind: GroupKind;
    /** The modes the group opens its boundary with; a `batch` opens none. */
    readonly options?: TransactionOptions;
    readonly calls: readonly Executable[];
    readonly [Result]?: R;
}

/** A tolerated group's outcome: what it produced, or the failure that rolled it back. */
export type Attempted<R> =
    | { readonly ok: true; readonly value: R }
    | { readonly ok: false; readonly error: { readonly message: string; readonly path: number[] } };

/** What `exec` accepts: a call, or a group of them. */
export type Executable<R = unknown> = Call<R> | Group<R>;

/** One call of a group body, as it travels on the wire. A group names the operation, not its route. */
type WireCall = { call: { operation: string; argument: unknown } };

/** A nested group of a group body. */
type WireGroup = { group: { kind: GroupKind; options?: TransactionOptions; calls: Wire[] } };

/** A group body: a tree of calls and groups, mirroring the group handler's shape. */
export type Wire = WireCall | WireGroup;

/** The path the group entry point is mounted at. See docs/transactions.md. */
export const GROUP_PATH = "/$group";

/** The result `E` describes. */
type ResultOf<E> = E extends { readonly [Result]?: infer R } ? R : never;

/** The results of `T`, in order. */
type Results<T extends readonly Executable[]> = { -readonly [K in keyof T]: ResultOf<T[K]> };

/** An all-void group reads as `void`; anything else keeps its tuple. */
type GroupResult<T extends readonly Executable[]> = Results<T> extends readonly void[]
    ? void
    : Results<T>;

/** Build one call. Generated modules are the only callers. */
export function call<R>(operation: string, method: Method, path: string, argument: unknown): Call<R> {
    return { kind: "call", operation, method, path, argument };
}

/** Group calls into one request, all-or-nothing: a boundary that fails loudly, opened with no modes. */
export function transaction<const T extends readonly Executable[]>(...calls: T): Group<GroupResult<T>> {
    return { kind: "transaction", calls };
}

/** {@link transaction}, opened with the modes the call names. */
export function transactionWith<const T extends readonly Executable[]>(
    options: TransactionOptions,
    ...calls: T
): Group<GroupResult<T>> {
    return { kind: "transaction", options, calls };
}

/** Like `transaction`, but a failure is reported rather than raised. See docs/transactions.md. */
export function attempt<const T extends readonly Executable[]>(...calls: T): Group<Attempted<GroupResult<T>>> {
    return { kind: "attempt", calls };
}

/** {@link attempt}, opened with the modes the call names. */
export function attemptWith<const T extends readonly Executable[]>(
    options: TransactionOptions,
    ...calls: T
): Group<Attempted<GroupResult<T>>> {
    return { kind: "attempt", options, calls };
}

/** Group calls into one request, each committing on its own. */
export function batch<const T extends readonly Executable[]>(...calls: T): Group<GroupResult<T>> {
    return { kind: "batch", calls };
}

/** Render one executable as the tree the group route reads. */
function toWire(executable: Executable): Wire {
    if (executable.kind === "call") {
        return { call: { operation: executable.operation, argument: executable.argument } };
    }
    return {
        group: {
            kind: executable.kind,
            ...(executable.options === undefined ? {} : { options: executable.options }),
            calls: executable.calls.map(toWire),
        },
    };
}

/** Send one executable and resolve with its result. */
export async function exec<R>(http: HttpClient, executable: Executable<R>): Promise<R> {
    return (await run(http, executable)) as R;
}

/** {@link exec}, before the result is asserted to `R`. */
async function run(http: HttpClient, executable: Executable): Promise<unknown> {
    if (executable.kind !== "call") {
        return await http.send("POST", GROUP_PATH, toWire(executable));
    }
    const { method, path, argument } = executable;
    // The transport picks the carrier from the verb, so the call site never mentions it.
    return method === "GET" || method === "DELETE"
        ? await http.query(method, path, argument)
        : await http.send(method, path, argument);
}
