import type { $brand } from "zod";

/**
 * A decimal number carried as a string, so precision is not lost. See docs/primitives.md.
 *
 * @primitive
 * @pgtype decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">()
 */
export type Decimal = string & $brand<"Decimal">;
