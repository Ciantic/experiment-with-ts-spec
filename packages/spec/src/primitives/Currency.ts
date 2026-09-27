/**
 * An ISO 4217 currency code: these known codes plus any other string. See docs/primitives.md.
 *
 * @graphql String
 */
export type Currency =
    | "EUR"
    | "USD"
    | "GBP"
    | "SEK"
    | (string & {});
