/** The errors this package raises itself, keyed by the wire kind that rebuilds them; hand-written. See docs/errors.md. */
import { AppError, type AppErrorOptions } from "./errorBase.ts";

/** The constructor shape every class the wire rebuilds shares. */
export type ErrorClass = new (message: string, options?: AppErrorOptions) => AppError;

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

/** A write that matched fewer rows than the call addressed; the SQLSTATE clients already treat as retriable. */
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

/** A call exists in the spec and is wired to a route, but its implementation is still the scaffold. */
export class NotImplemented extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "not-implemented", status: 501 }, options);
    }
}

/** The errors this module defines, keyed by the wire kind that rebuilds them. */
export const BUILTIN_ERROR_CLASSES: Record<string, ErrorClass> = {
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
    "not-implemented": NotImplemented,
};
