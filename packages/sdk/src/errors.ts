/** The errors the API reports and the SDK re-raises: the hand-written classes, then the ones the spec declares. See docs/errors.md. */
import type { AppError } from "./errorBase.ts";
import { BUILTIN_ERROR_CLASSES, type ErrorClass } from "./builtinErrors.ts";
import { SPEC_ERROR_CLASSES } from "./specErrors.ts";

export { AppError, apiErrorBody, type ApiErrorBody, type AppErrorOptions } from "./errorBase.ts";
export * from "./builtinErrors.ts";
export * from "./specErrors.ts";

/** Every error the wire rebuilds: the hand-written classes, then the ones the spec's `@throws` declares. */
const ERROR_CLASSES: Record<string, ErrorClass> = { ...BUILTIN_ERROR_CLASSES, ...SPEC_ERROR_CLASSES };

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
