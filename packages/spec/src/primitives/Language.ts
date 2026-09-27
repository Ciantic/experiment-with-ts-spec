/**
 * A language an invoice is rendered in: these known languages plus any other
 * string. See docs/invoice-sending.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.enum(["fi", "sv", "en"]).or(z.string())
 */
export type Language =
    | "fi"
    | "sv"
    | "en"
    | (string & {});
