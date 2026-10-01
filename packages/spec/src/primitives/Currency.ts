/**
 * An ISO 4217 currency code: these known codes plus any other string. See docs/primitives.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.enum(["EUR", "USD", "GBP", "SEK"]).or(z.string())
 * @effect Schema.Union([Schema.Literals(["EUR", "USD", "GBP", "SEK"]), Schema.String])
 */
export type Currency =
    | "EUR"
    | "USD"
    | "GBP"
    | "SEK"
    | (string & {});
