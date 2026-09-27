import type { Decimal } from "./Decimal.js";

/**
 * A tax rate as a fraction, so 25.5% is "0.255". See docs/primitives.md.
 *
 * @graphql TaxRate
 */
export type TaxRate = Decimal & { readonly __brand: "TaxRate" };
