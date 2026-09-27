import type { Decimal } from "./Decimal.js";

/**
 * A count of units. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @graphql Quantity
 */
export type Quantity = Decimal & { readonly __brand: "Quantity" };
