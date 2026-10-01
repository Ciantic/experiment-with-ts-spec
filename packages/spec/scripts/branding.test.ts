/**
 * Guards that a spec branded primitive accepts both brand vocabularies.
 * See docs/primitives.md.
 *
 * A spec type is `T & ($brand<Name> | Brand.Brand<Name>)`, so a value branded by
 * Zod (its `@zod` schema) or by Effect (its `@effect` schema) must be assignable
 * to it. A single-brand spelling would make one backend's decoded value silently
 * unassignable, which no runtime test could catch. The `@ts-expect-error` below
 * fails the typecheck if distinct brands ever become interchangeable.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { BrandedId } from "../src/primitives/BrandedId.ts";
import type { Money } from "../src/primitives/Money.ts";
import type { Version } from "../src/primitives/Version.ts";

/** A UUID both id schemas accept. */
const UUID = "123e4567-e89b-42d3-a456-426614174000";

/** The decimal shape `Decimal`, `Money`, and their kin share. */
const DECIMAL = /^-?\d+(\.\d+)?$/;

describe("a spec brand accepts both vocabularies", () => {
    it("accepts a Zod-branded and an Effect-branded id", () => {
        const zodId: BrandedId<"InvoiceId"> = z.uuid().brand<"InvoiceId">().parse(UUID);
        const effectId: BrandedId<"InvoiceId"> = Schema.decodeUnknownSync(
            Schema.String.check(Schema.isUUID()).pipe(Schema.brand("InvoiceId")),
        )(UUID);

        expect(zodId).toBe(UUID);
        expect(effectId).toBe(UUID);
    });

    it("accepts a Zod-branded and an Effect-branded amount", () => {
        const zodMoney: Money = z.string().regex(DECIMAL).brand<"Decimal">().brand<"Money">().parse("10.00");
        const effectMoney: Money = Schema.decodeUnknownSync(
            Schema.String.check(Schema.isPattern(DECIMAL)).pipe(Schema.brand("Decimal"), Schema.brand("Money")),
        )("10.00");

        expect(zodMoney).toBe("10.00");
        expect(effectMoney).toBe("10.00");
    });

    it("accepts a Zod-branded and an Effect-branded version", () => {
        const zodVersion: Version = z.bigint().brand<"Version">().parse(1n);
        const effectVersion: Version = Schema.decodeUnknownSync(Schema.BigInt.pipe(Schema.brand("Version")))(1n);

        expect(zodVersion).toBe(1n);
        expect(effectVersion).toBe(1n);
    });

    it("keeps distinct brands distinct", () => {
        const invoice: BrandedId<"InvoiceId"> = z.uuid().brand<"InvoiceId">().parse(UUID);
        // @ts-expect-error an InvoiceId is not a CustomerId
        const wrong: BrandedId<"CustomerId"> = invoice;
        void wrong;

        expect(invoice).toBe(UUID);
    });
});
