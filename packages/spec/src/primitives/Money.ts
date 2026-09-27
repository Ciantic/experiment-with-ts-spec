import type { $brand } from "zod";
import type { Decimal } from "./Decimal.js";

/**
 * A monetary amount. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @primitive
 * @pgtype decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">().brand<"Money">()
 */
export type Money = Decimal & $brand<"Money">;
