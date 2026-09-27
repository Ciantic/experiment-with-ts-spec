import type { $brand } from "zod";
import type { Decimal } from "./Decimal.js";

/**
 * A count of units. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @primitive
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">().brand<"Quantity">()
 */
export type Quantity = Decimal & $brand<"Quantity">;
