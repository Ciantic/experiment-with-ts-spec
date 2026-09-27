/**
 * An ISO 4217 currency code: these known codes plus any other string. See docs/primitives.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.enum(["EUR", "USD", "GBP", "SEK"]).or(z.string())
 */
export type Currency =
    | "EUR"
    | "USD"
    | "GBP"
    | "SEK"
    | (string & {});
