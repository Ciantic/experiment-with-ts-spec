/**
 * A monetary amount expressed in the smallest indivisible unit of a currency
 * (for example cents), so that no rounding is lost.
 */
export type Price = bigint & { readonly __brand: "Price" };
