/** Unit tests for the response value and its wire form. See docs/testing.md. */
import { parse as decode } from "devalue";
import { describe, expect, it } from "vitest";
import { QueryError, RequestError, VersionConflictError } from "sdk/errors.ts";
import { ApiHttpResponse } from "./api-http-response.ts";

describe("ApiHttpResponse", () => {
    it("carries a success value and encodes it with devalue on the wire", () => {
        const response = ApiHttpResponse.ok({ at: new Date(0) });
        const wire = response.toWire();

        expect(response.statusCode).toBe(200);
        expect(response.payload).toEqual({ at: new Date(0) });
        expect(wire.statusCode).toBe(200);
        expect(wire.headers).toEqual({ "content-type": "application/json" });
        expect(decode(wire.body)).toEqual({ at: new Date(0) });
    });

    it("carries an undefined value as null", () => {
        const response = ApiHttpResponse.ok(undefined);

        expect(response.payload).toBeNull();
        expect(decode(response.toWire().body)).toBeNull();
    });

    it("carries a failure as a plain error body and writes it as JSON", () => {
        const response = ApiHttpResponse.failure(new RequestError("malformed request"));

        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: "malformed request", kind: "request" });
        expect(response.toWire().body).toBe(JSON.stringify({ error: "malformed request", kind: "request" }));
    });

    it("takes the status from the AppError, or from the driver's SQLSTATE", () => {
        expect(ApiHttpResponse.failure(new QueryError("bad read")).statusCode).toBe(400);
        expect(ApiHttpResponse.failure(new VersionConflictError("stale")).statusCode).toBe(409);
        expect(ApiHttpResponse.failure(Object.assign(new Error("version conflict"), { code: "40001" })).statusCode).toBe(
            409,
        );
        expect(ApiHttpResponse.failure(new Error("boom")).statusCode).toBe(500);
    });
});
