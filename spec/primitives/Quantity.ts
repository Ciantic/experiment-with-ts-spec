/** A count of units. A `Decimal` refined with its own brand. See docs/primitives.md. */
import type { Decimal } from "./Decimal.js";

export type Quantity = Decimal & { readonly __brand: "Quantity" };
