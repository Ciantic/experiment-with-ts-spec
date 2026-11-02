/** Unit tests for the response value and its wire form. See docs/testing.md. */
import type { ServerResponse } from "node:http";
import { parse as decode } from "devalue";
import { describe, expect, it } from "vitest";
import { QueryError, RequestError, VersionConflictError } from "sdk/errors.ts";
import { ApiHttpResponse } from "./api-http-response.ts";

/** A `ServerResponse` stand-in, recording what a write puts on it. */
function responseSpy(): {
    response: ServerResponse;
    written: { statusCode?: number; headers?: Record<string, string>; body?: string };
} {
    const written: { statusCode?: number; headers?: Record<string, string>; body?: string } = {};
    const response = {
        writeHead: (statusCode: number, headers: Record<string, string>) => {
            written.statusCode = statusCode;
            written.headers = headers;
        },
        end: (body: string) => {
            written.body = body;
        },
    } as unknown as ServerResponse;
    return { response, written };
}

describe("ApiHttpResponse", () => {
    it("carries a success value and encodes it with devalue on the wire", () => {
        const response = ApiHttpResponse.ok({ at: new Date(0) });
        const { response: stream, written } = responseSpy();

        response.writeTo(stream);

        expect(response.statusCode).toBe(200);
        expect(response.payload).toEqual({ at: new Date(0) });
        expect(written.statusCode).toBe(200);
        expect(written.headers).toEqual({ "content-type": "application/json" });
        expect(decode(written.body ?? "")).toEqual({ at: new Date(0) });
    });

    it("carries an undefined value as null", () => {
        const response = ApiHttpResponse.ok(undefined);
        const { response: stream, written } = responseSpy();

        response.writeTo(stream);

        expect(response.payload).toBeNull();
        expect(decode(written.body ?? "")).toBeNull();
    });

    it("carries a failure as a plain error body and writes it as JSON", () => {
        const response = ApiHttpResponse.failure(new RequestError("malformed request"));
        const { response: stream, written } = responseSpy();

        response.writeTo(stream);

        expect(response.statusCode).toBe(400);
        expect(response.payload).toEqual({ error: "malformed request", kind: "request" });
        expect(written.body).toBe(JSON.stringify({ error: "malformed request", kind: "request" }));
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
