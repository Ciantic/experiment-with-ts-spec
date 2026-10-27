import type { Brand } from "./Brand.ts";
import type { Decimal } from "./Decimal.ts";

/**
 * A monetary amount. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @primitive
 * @pgType decimal
 * @zod z.string().regex(/^-?\d+(\.\d+)?$/).brand<"Decimal">().brand<"Money">()
 */
export type Money = Decimal & Brand<"Money">;
