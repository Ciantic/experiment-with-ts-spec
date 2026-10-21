/** The base every reported error extends, and the plain-JSON body it becomes; hand-written and outside the barrels. See docs/errors.md. */

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
