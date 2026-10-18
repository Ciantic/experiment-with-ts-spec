/**
 * An e-invoice operator (välittäjätunnus) that routes an invoice on the network. See docs/invoice-sending.md.
 * @primitive
 * @pgType text
 * @zod z.enum(["maventa", "apix", "op", "basware"]).or(z.string())
 */
export type EInvoiceOperator =
    | "maventa"
    | "apix"
    | "op"
    | "basware"
    | (string & {});
