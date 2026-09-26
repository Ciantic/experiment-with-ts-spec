/** A monetary amount in the currency's smallest unit, so no rounding is lost. See docs/primitives.md. */
export type Price = bigint & { readonly __brand: "Price" };
