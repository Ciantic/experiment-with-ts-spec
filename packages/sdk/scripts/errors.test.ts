/** Unit tests for the shared error contract: the wire body and the class it rebuilds. See docs/errors.md. */
import { describe, expect, it } from "vitest";
import {
    BadGroupError,
    DriverResultError,
    NoMatchingRowError,
    NotFoundError,
    PayloadTooLargeError,
    QueryError,
    RequestError,
    SavepointOptionsError,
    ShortWriteError,
    ValidationError,
    VersionConflictError,
    apiErrorBody,
    apiErrorFromBody,
} from "../src/errors.ts";

/** Every error the wire can name, so the registry is checked against the classes it claims. */
const WIRE_ERRORS = [
    new RequestError("request"),
    new NotFoundError("not found"),
    new ValidationError("validation"),
    new PayloadTooLargeError("too large"),
    new BadGroupError("bad group"),
    new QueryError("query"),
    new VersionConflictError("version"),
    new NoMatchingRowError("no row"),
    new ShortWriteError("short"),
    new DriverResultError("driver"),
    new SavepointOptionsError("savepoint"),
];

describe("apiErrorBody", () => {
    it("names the kind a client rebuilds", () => {
        expect(apiErrorBody(new VersionConflictError("stale"))).toEqual({
            error: "stale",
            kind: "version-conflict",
        });
    });

    it("carries the path and issues a group refusal reports", () => {
        expect(apiErrorBody(new BadGroupError("bad", { path: [1], issues: ["wrong"] }))).toEqual({
            error: "bad",
            kind: "bad-group",
            path: [1],
            issues: ["wrong"],
        });
    });

    it("leaves an unclassified failure with its message alone", () => {
        expect(apiErrorBody(new Error("boom"))).toEqual({ error: "boom" });
        expect(apiErrorBody("boom")).toEqual({ error: "request failed" });
    });
});

describe("apiErrorFromBody", () => {
    it("rebuilds every kind with the status the response carried", () => {
        for (const error of WIRE_ERRORS) {
            const rebuilt = apiErrorFromBody(error.status, apiErrorBody(error));

            expect(rebuilt, error.kind).toBeInstanceOf(error.constructor);
            expect(rebuilt?.kind, error.kind).toBe(error.kind);
            expect(rebuilt?.status, error.kind).toBe(error.status);
            expect(rebuilt?.message, error.kind).toBe(error.message);
        }
    });

    it("keeps the path and issues a group refusal carries", () => {
        const rebuilt = apiErrorFromBody(
            400,
            apiErrorBody(new BadGroupError("bad", { path: [1, 0], issues: ["wrong"] })),
        );

        expect(rebuilt).toBeInstanceOf(BadGroupError);
        expect(rebuilt?.path).toEqual([1, 0]);
        expect(rebuilt?.issues).toEqual(["wrong"]);
    });

    it("takes the status from the response, not the class default", () => {
        const rebuilt = apiErrorFromBody(409, { error: "stale", kind: "version-conflict" });

        expect(rebuilt?.status).toBe(409);
        expect(rebuilt?.code).toBe("40001");
    });

    it("answers undefined for a kind it does not know, or a body with no kind", () => {
        expect(apiErrorFromBody(500, { error: "newer", kind: "not-implemented-yet" })).toBeUndefined();
        expect(apiErrorFromBody(409, { error: "stale" })).toBeUndefined();
        expect(apiErrorFromBody(409, "stale")).toBeUndefined();
    });

    it("does not rebuild a name inherited from Object.prototype", () => {
        expect(apiErrorFromBody(500, { error: "proto", kind: "__proto__" })).toBeUndefined();
        expect(apiErrorFromBody(500, { error: "constructor", kind: "constructor" })).toBeUndefined();
        expect(apiErrorFromBody(500, { error: "toString", kind: "toString" })).toBeUndefined();
    });
});
