import type { $brand } from "zod";

/**
 * A Finnish e-invoice address (verkkolaskuosoite / OVT): a routing address such
 * as `003712345678`, the operator scheme prefix followed by the business id.
 * See docs/invoice-sending.md.
 *
 * @primitive
 * @pgtype text
 * @zod z.string().brand<"EInvoiceAddress">()
 */
export type EInvoiceAddress = string & $brand<"EInvoiceAddress">;
