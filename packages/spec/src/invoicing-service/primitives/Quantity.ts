import type { Brand } from "../../primitives/Brand.ts";
import type { Decimal } from "../../primitives/Decimal.ts";

/**
 * A count of units. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @primitive
 * @pgType decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">().brand<"Quantity">()
 */
export type Quantity = Decimal & Brand<"Quantity">;
