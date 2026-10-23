/** Unit tests for the Postgres type vocabulary. The linter's resolve walk is covered by lint-spec.test.ts. */
import { describe, expect, it } from "vitest";
import { DEFAULT_PG_TYPES, selectJsType } from "./pg-types.ts";

describe("selectJsType", () => {
    it("reads the select type of a mapped type and of Postgres' own spelling of it", () => {
        expect(selectJsType("int8")).toBe("bigint");
        expect(selectJsType("integer")).toBe("number");
        expect(selectJsType("decimal")).toBe("string");
        expect(selectJsType("timestamptz")).toBe("Date");
        expect(selectJsType("bytea")).toBe("Uint8Array");
    });

    it("does not know a name outside the mapping", () => {
        expect(selectJsType("int83")).toBeUndefined();
    });
});

describe("DEFAULT_PG_TYPES", () => {
    it("maps every bare TypeScript type to a Postgres type that selects as that type", () => {
        for (const [jsType, pgType] of Object.entries(DEFAULT_PG_TYPES)) {
            expect(selectJsType(pgType), `${jsType} -> ${pgType}`).toBe(jsType);
        }
    });
});
