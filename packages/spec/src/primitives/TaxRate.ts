import type { $brand } from "zod";
import type { Decimal } from "./Decimal.ts";

/**
 * A tax rate as a fraction, so 25.5% is "0.255". See docs/primitives.md.
 *
 * @primitive
 * @pgtype decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">().brand<"TaxRate">()
 */
export type TaxRate = Decimal & $brand<"TaxRate">;
