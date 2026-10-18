/** The HTTP result shape and the plain-JSON failures both handlers answer with. See docs/rest-api.md. */
import { AppError, apiErrorBody } from "sdk/errors.ts";

/** One response. Success bodies are `devalue`; error bodies are plain JSON. */
export interface HttpResponse {
    status: number;
    body: string;
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

/** The status a thrown error maps to: an {@link AppError} names its own, and a driver error maps from its SQLSTATE. */
export function statusFor(thrown: unknown): number {
    if (thrown instanceof AppError) {
        return thrown.status;
    }
    const code = (thrown as { code?: unknown }).code;
    if (typeof code !== "string" || !Object.hasOwn(ERROR_STATUSES, code)) {
        return 500;
    }
    return ERROR_STATUSES[code] ?? 500;
}

/** The plain-JSON response for a thrown error, carrying the kind the SDK rebuilds it from. */
export function errorFrom(thrown: unknown): HttpResponse {
    return { status: statusFor(thrown), body: JSON.stringify(apiErrorBody(thrown)) };
}
