/** Unit tests for the response value and its wire form. See docs/testing.md. */
import type { ServerResponse } from "node:http";
import { parse as decode } from "devalue";
import { describe, expect, it } from "vitest";
import { QueryError, RequestError, VersionConflictError } from "sdk/errors.ts";
import { ApiHttpResponse, WritableResponse } from "./api-http-response.ts";

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

/** The status a response writes. */
function statusOf(response: ApiHttpResponse): number | undefined {
    const { response: stream, written } = responseSpy();
    response.writeTo(stream);
    return written.statusCode;
}

describe("ApiHttpResponse", () => {
    it("writes a success value encoded with devalue", () => {
        const response = ApiHttpResponse.ok({ at: new Date(0) });
        const { response: stream, written } = responseSpy();

        response.writeTo(stream);

        expect(written.statusCode).toBe(200);
        expect(written.headers).toEqual({ "content-type": "application/json" });
        expect(decode(written.body ?? "")).toEqual({ at: new Date(0) });
    });

    it("writes an undefined value as null", () => {
        const response = ApiHttpResponse.ok(undefined);
        const { response: stream, written } = responseSpy();

        response.writeTo(stream);

        expect(decode(written.body ?? "")).toBeNull();
    });

    it("writes a failure as a plain-JSON error body", () => {
        const response = ApiHttpResponse.failure(new RequestError("malformed request"));
        const { response: stream, written } = responseSpy();

        response.writeTo(stream);

        expect(written.statusCode).toBe(400);
        expect(written.body).toBe(JSON.stringify({ error: "malformed request", kind: "request" }));
    });

    it("takes the status from the AppError, or from the driver's SQLSTATE", () => {
        expect(statusOf(ApiHttpResponse.failure(new QueryError("bad read")))).toBe(400);
        expect(statusOf(ApiHttpResponse.failure(new VersionConflictError("stale")))).toBe(409);
        expect(statusOf(ApiHttpResponse.failure(Object.assign(new Error("version conflict"), { code: "40001" })))).toBe(
            409,
        );
        expect(statusOf(ApiHttpResponse.failure(new Error("boom")))).toBe(500);
    });

    it("answers the request itself, so it is a writable", () => {
        expect(ApiHttpResponse.ok(null)).toBeInstanceOf(WritableResponse);
        expect(ApiHttpResponse.failure(new Error("boom"))).toBeInstanceOf(WritableResponse);
    });
});
