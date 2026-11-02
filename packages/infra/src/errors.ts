/** The errors the server raises itself that never reach the wire. See docs/errors.md. */
import { AppError } from "sdk/errors.ts";

/** Mock data the spec declares but no generated repository can write. */
export class MockDataError extends AppError {
    constructor(message: string) {
        super(message, { kind: "mock-data", status: 500 });
    }
}

/** A notification subscription on an executor whose driver has no LISTEN support; it never reaches an HTTP response. */
export class NotificationsUnsupportedError extends AppError {
    constructor() {
        super("this executor does not support notifications", { kind: "notifications-unsupported", status: 501 });
    }
}
