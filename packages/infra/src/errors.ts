/** The errors the server raises itself that never reach the wire. See docs/errors.md. */
import { AppError } from "sdk/errors.ts";

/** A command line the entry point cannot interpret; it never reaches an HTTP response. */
export class UsageError extends AppError {
    constructor(message: string) {
        super(message, { kind: "usage", status: 400 });
    }
}

/** Mock data the spec declares but no generated repository can write. */
export class MockDataError extends AppError {
    constructor(message: string) {
        super(message, { kind: "mock-data", status: 500 });
    }
}
