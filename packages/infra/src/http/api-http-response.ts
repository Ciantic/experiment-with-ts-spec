/** The API response value and the plain-JSON failures both handlers answer with. See docs/rest-api.md. */
import { stringify as encode } from "devalue";
import { AppError, apiErrorBody } from "sdk/errors.ts";

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

/** What `node:http` writes: the status line, the headers, and the body. */
export interface WireResponse {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
}

/** How a response's payload becomes its wire body. */
type BodyEncoding = "devalue" | "json";

/** One API response, holding the value the client receives and how it becomes the wire body. */
export class ApiHttpResponse {
    readonly statusCode: number;
    /** The handler's result for a success, or the error body for a failure. */
    readonly payload: unknown;
    private readonly encoding: BodyEncoding;

    private constructor(statusCode: number, payload: unknown, encoding: BodyEncoding) {
        this.statusCode = statusCode;
        this.payload = payload;
        this.encoding = encoding;
    }

    /** A success carrying `value`; `undefined` encodes as `null`, as a miss and a void write do. */
    static ok(value: unknown): ApiHttpResponse {
        return new ApiHttpResponse(200, value ?? null, "devalue");
    }

    /** The answer for a thrown error, carrying the kind the SDK rebuilds it from. */
    static failure(thrown: unknown): ApiHttpResponse {
        return new ApiHttpResponse(statusFor(thrown), apiErrorBody(thrown), "json");
    }

    /** This response as the status, headers, and body `node:http` writes. */
    toWire(): WireResponse {
        const body = this.encoding === "devalue" ? encode(this.payload) : JSON.stringify(this.payload);
        return { statusCode: this.statusCode, headers: { "content-type": "application/json" }, body };
    }
}
