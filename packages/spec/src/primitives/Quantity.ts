import type { Brand } from "./Brand.ts";
import type { Decimal } from "./Decimal.ts";

/**
 * A count of units. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @primitive
 * @pgtype decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">().brand<"Quantity">()
 * @effect Schema.String.check(Schema.isPattern(/^-?\d+(\.\d+)?$/)).pipe(Schema.brand("Decimal"), Schema.brand("Quantity"))
 */
export type Quantity = Decimal & Brand<"Quantity">;
