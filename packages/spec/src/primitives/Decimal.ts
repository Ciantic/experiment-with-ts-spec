import type { Brand } from "./Brand.ts";

/**
 * A decimal number carried as a string, so precision is not lost. See docs/primitives.md.
 *
 * @primitive
 * @pgtype decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">()
 * @effect Schema.String.check(Schema.isPattern(/^-?\d+(\.\d+)?$/)).pipe(Schema.brand("Decimal"))
 */
export type Decimal = string & Brand<"Decimal">;
