import type { Brand } from "./Brand.ts";

/**
 * A decimal number carried as a string, so precision is not lost. See docs/primitives.md.
 *
 * @primitive
 * @pgType decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">()
 */
export type Decimal = string & Brand<"Decimal">;
