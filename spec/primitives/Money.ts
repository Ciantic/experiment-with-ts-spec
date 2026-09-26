/** A monetary amount. A `Decimal` refined with its own brand. See docs/primitives.md. */
import type { Decimal } from "./Decimal.js";

export type Money = Decimal & { readonly __brand: "Money" };
