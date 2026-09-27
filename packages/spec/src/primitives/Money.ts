import type { Decimal } from "./Decimal.js";

/**
 * A monetary amount. A `Decimal` refined with its own brand. See docs/primitives.md.
 *
 * @graphql Money
 */
export type Money = Decimal & { readonly __brand: "Money" };
