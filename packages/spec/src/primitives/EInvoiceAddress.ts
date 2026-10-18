import type { Brand } from "./Brand.ts";

/**
 * A Finnish e-invoice address (verkkolaskuosoite / OVT): the operator prefix followed by the business id. See docs/invoice-sending.md.
 * @primitive
 * @pgType text
 * @zod z.string().brand<"EInvoiceAddress">()
 */
export type EInvoiceAddress = string & Brand<"EInvoiceAddress">;
