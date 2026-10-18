/** The errors the API reports and the SDK re-raises; hand-written and outside the barrels. See docs/errors.md. */

/** What an error carries beyond its message; a client fills these from the response it received. */
export interface AppErrorOptions {
    /** The HTTP status of the response, which a reconstructed error takes from the wire. */
    status?: number;
    /** The SQLSTATE a driver raised, when this error reports one. */
    code?: string;
    /** The tree path of the group entry that failed. */
    path?: number[];
    /** The validation issues a refused argument carries, as the schema reported them. */
    issues?: unknown;
    /** The failure this error answers for. */
    cause?: unknown;
}

/** The plain-JSON body of a failed response. See docs/rest-api.md. */
export interface ApiErrorBody {
    error: string;
    kind?: string;
    path?: number[];
    issues?: unknown;
}

/** What every error the API reports extends, so a catch can tell a reported failure from a fault. */
export class AppError extends Error {
    /** The wire token a client uses to rebuild this error; undefined when the server did not classify it. */
    readonly kind: string | undefined;
    /** The HTTP status the error answers with. */
    readonly status: number;
    /** The SQLSTATE a driver raised, when this error carries one. */
    readonly code: string | undefined;
    /** The tree path of the group entry that raised, when the failure came from a group. */
    readonly path: number[] | undefined;
    /** The validation issues a refused argument carries. */
    readonly issues: unknown;

    protected constructor(
        message: string,
        defaults: { kind?: string; status: number; code?: string },
        options: AppErrorOptions = {},
    ) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = new.target.name;
        this.kind = defaults.kind;
        this.status = options.status ?? defaults.status;
        this.code = options.code ?? defaults.code;
        this.path = options.path;
        this.issues = options.issues;
    }
}

/** A request the server refuses before it reaches a handler. */
export class RequestError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "request", status: 400 }, options);
    }
}

/** A route the table does not have. */
export class NotFoundError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "not-found", status: 404 }, options);
    }
}

/** An argument the route's schema refused; `issues` is the schema's report. */
export class ValidationError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "validation", status: 400 }, options);
    }
}

/** A request body past the transport's cap. */
export class PayloadTooLargeError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "payload-too-large", status: 413 }, options);
    }
}

/** A group body the handler refuses before any of it runs, naming the entry that is wrong. */
export class BadGroupError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "bad-group", status: 400 }, options);
    }
}

/** A read the query model cannot plan into SQL: a field, filter, order, or paging the generated schema let through. */
export class QueryError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "query", status: 400 }, options);
    }
}

/** A write that matched fewer rows than the call addressed; the same SQLSTATE the version trigger raises. */
export class ConflictError extends AppError {
    protected constructor(kind: string, message: string, options: AppErrorOptions = {}) {
        super(message, { kind, status: 409, code: "40001" }, options);
    }
}

/** A patch or upsert claimed a version the stored row no longer holds. */
export class VersionConflictError extends ConflictError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super("version-conflict", message, options);
    }
}

/** A versionless patch addressed a key that is not there. */
export class NoMatchingRowError extends ConflictError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super("no-matching-row", message, options);
    }
}

/** A statement returned fewer rows than it carried: the database declined without raising. */
export class ShortWriteError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "short-write", status: 500 }, options);
    }
}

/** A driver answered a result in a shape the port does not understand. */
export class DriverResultError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "driver-result", status: 500 }, options);
    }
}

/** A nested boundary was asked for transaction options, which only a root boundary can take. */
export class SavepointOptionsError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "savepoint-options", status: 400 }, options);
    }
}

/** The body a failed response carries: its message, and whatever a client needs to rebuild the error. */
export function apiErrorBody(thrown: unknown): ApiErrorBody {
    const error = thrown instanceof Error ? thrown.message : "request failed";
    if (!(thrown instanceof AppError)) {
        return { error };
    }
    return {
        error,
        ...(thrown.kind === undefined ? {} : { kind: thrown.kind }),
        ...(thrown.path === undefined ? {} : { path: thrown.path }),
        ...(thrown.issues === undefined ? {} : { issues: thrown.issues }),
    };
}

/** The class each wire kind rebuilds; a kind this package does not know keeps the generic `HttpError`. */
const ERROR_CLASSES: Record<string, new (message: string, options?: AppErrorOptions) => AppError> = {
    "request": RequestError,
    "not-found": NotFoundError,
    "validation": ValidationError,
    "payload-too-large": PayloadTooLargeError,
    "bad-group": BadGroupError,
    "query": QueryError,
    "version-conflict": VersionConflictError,
    "no-matching-row": NoMatchingRowError,
    "short-write": ShortWriteError,
    "driver-result": DriverResultError,
    "savepoint-options": SavepointOptionsError,
};

/** Whether a decoded value is the path a group failure carries. */
function readPath(value: unknown): number[] | undefined {
    if (!Array.isArray(value) || !value.every((step) => typeof step === "number")) {
        return undefined;
    }
    return value;
}

/** Rebuild the error a response body names, or answer undefined when the body is not one this package defines. */
export function apiErrorFromBody(status: number, body: unknown): AppError | undefined {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const record = body as { error?: unknown; kind?: unknown; path?: unknown; issues?: unknown };
    if (typeof record.error !== "string" || typeof record.kind !== "string") {
        return undefined;
    }
    // The body is untrusted, so a name inherited from Object.prototype is not a kind this package defines.
    if (!Object.hasOwn(ERROR_CLASSES, record.kind)) {
        return undefined;
    }
    const ErrorClass = ERROR_CLASSES[record.kind];
    if (ErrorClass === undefined) {
        return undefined;
    }
    const path = readPath(record.path);
    return new ErrorClass(record.error, {
        status,
        ...(path === undefined ? {} : { path }),
        ...(record.issues === undefined ? {} : { issues: record.issues }),
    });
}
