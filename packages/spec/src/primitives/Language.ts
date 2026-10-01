/**
 * A language an invoice is rendered in: these known languages plus any other
 * string. See docs/invoice-sending.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.enum(["fi", "sv", "en"]).or(z.string())
 * @effect Schema.Union([Schema.Literals(["fi", "sv", "en"]), Schema.String])
 */
export type Language =
    | "fi"
    | "sv"
    | "en"
    | (string & {});
