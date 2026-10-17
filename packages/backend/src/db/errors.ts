/** The errors the database layer raises itself. A driver failure is not one of these; it arrives with its own SQLSTATE. */
import { AppError, type AppErrorOptions } from "../errors.ts";

/** The base of every error the database layer raises itself. */
export class DbError extends AppError {
    protected constructor(message: string, status: number, options: AppErrorOptions = {}) {
        super(message, status, options);
    }
}

/** A read the query model cannot plan into SQL: a field, filter, order, or paging the generated schema let through. */
export class QueryError extends DbError {
    constructor(message: string) {
        super(message, 400);
    }
}

/** A write that matched fewer rows than the call addressed; the same SQLSTATE the version trigger raises. */
export class ConflictError extends DbError {
    constructor(message: string) {
        super(message, 409, { code: "40001" });
    }
}

/** A patch or upsert claimed a version the stored row no longer holds. */
export class VersionConflictError extends ConflictError {
    constructor(message: string) {
        super(message);
    }
}

/** A patch or upsert addressed a key that is not there. */
export class NoMatchingRowError extends ConflictError {
    constructor(message: string) {
        super(message);
    }
}

/** A statement returned fewer rows than it carried: the database declined without raising. */
export class ShortWriteError extends DbError {
    constructor(message: string) {
        super(message, 500);
    }
}

/** A driver answered a result in a shape the port does not understand. */
export class DriverResultError extends DbError {
    constructor(message: string) {
        super(message, 500);
    }
}

/** A nested boundary was asked for transaction options, which only a root boundary can take. */
export class SavepointOptionsError extends DbError {
    constructor(message: string) {
        super(message, 400);
    }
}
