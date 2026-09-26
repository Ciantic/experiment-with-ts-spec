/** A decimal number carried as a string, so precision is not lost. See docs/primitives.md. */
export type Decimal = string & { readonly __decimal: true };
