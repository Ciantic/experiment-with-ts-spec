/**
 * A decimal number carried as a string, so precision is not lost. See docs/primitives.md.
 *
 * @graphql Decimal
 */
export type Decimal = string & { readonly __decimal: true };
