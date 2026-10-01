/**
 * Guards that the generated primitives brand to Effect's branded types.
 * See docs/validation-effect.md.
 *
 * A brand is a phantom property, so a missing or mismatched one is invisible at
 * runtime and only shows up as a type error where a branded value is used. These
 * assertions fail the typecheck if the generator ever stops branding. The spec's
 * brands are `Brand.Brand<...>`, so the generated `Type` must be the same.
 */
import { Brand, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { brandedIdSchema, moneySchema, versionSchema } from "./validation/primitives.ts";

/** A UUID accepted by the id schemas. */
const UUID = "123e4567-e89b-42d3-a456-426614174000";

describe("generated primitives are branded", () => {
    it("brands a generic id with the name it is given", () => {
        const invoiceId = brandedIdSchema("InvoiceId");
        // The decoded type must be the exact brand the spec's `InvoiceId` carries.
        const asSpec: string & Brand.Brand<"InvoiceId"> = null as unknown as typeof invoiceId.Type;
        const asDecoded: typeof invoiceId.Type = null as unknown as string & Brand.Brand<"InvoiceId">;
        void asSpec;
        void asDecoded;

        expect(Schema.decodeUnknownResult(invoiceId)(UUID)._tag).toBe("Success");
        expect(Schema.decodeUnknownResult(invoiceId)("not-a-uuid")._tag).toBe("Failure");
    });

    it("brands a branded string primitive", () => {
        const asSpec: string & Brand.Brand<"Decimal"> & Brand.Brand<"Money"> = null as unknown as typeof moneySchema.Type;

        void asSpec;
        expect(Schema.decodeUnknownResult(moneySchema)("10.00")._tag).toBe("Success");
        expect(Schema.decodeUnknownResult(moneySchema)("free")._tag).toBe("Failure");
    });

    it("brands a branded bigint primitive", () => {
        const asSpec: bigint & Brand.Brand<"Version"> = null as unknown as typeof versionSchema.Type;

        void asSpec;
        expect(Schema.decodeUnknownResult(versionSchema)(1n)._tag).toBe("Success");
    });
});
