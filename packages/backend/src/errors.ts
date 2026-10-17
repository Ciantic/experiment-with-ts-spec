/** The errors the server raises itself, with the HTTP status each one answers. See docs/errors.md. */

/** What an {@link AppError} carries beyond its message. */
export interface AppErrorOptions {
    /** The SQLSTATE a driver raised, when this error reports one. */
    code?: string;
    /** The failure this error answers for. */
    cause?: unknown;
}

/** The base of every error the server raises itself, so a catch can tell a deliberate rejection from a fault. */
export class AppError extends Error {
    /** The HTTP status this error answers with. */
    readonly status: number;
    /** The SQLSTATE a driver raised, when this error carries one. */
    readonly code: string | undefined;

    protected constructor(message: string, status: number, options: AppErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = new.target.name;
        this.status = status;
        this.code = options.code;
    }
}

/** A request the server refuses before it reaches a handler. */
export class RequestError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, 400, options);
    }
}

/** A request body past the transport's cap. */
export class PayloadTooLargeError extends AppError {
    constructor(message: string) {
        super(message, 413);
    }
}

/** A command line the entry point cannot interpret; it never reaches an HTTP response. */
export class UsageError extends AppError {
    constructor(message: string) {
        super(message, 400);
    }
}

/** Mock data the spec declares but no generated repository can write. */
export class MockDataError extends AppError {
    constructor(message: string) {
        super(message, 500);
    }
}
