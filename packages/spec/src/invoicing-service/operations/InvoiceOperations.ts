import type { EmailId } from "../Email.ts";
import type { Invoice } from "../Invoice.ts";
import type { InvoiceSentId } from "../InvoiceSent.ts";

export interface InvoiceOperations<T> {
    /** 
     * Send the invoice to the recipient.
     * 
     * @throws {InvoiceDetailsError} status=422 when the invoice doesn't have enough details to be sent
     * 
     * @operation
     * @restOperation POST /invoice/send
     **/
    sendInvoice(ctx: T, opts: {
        invoice: Invoice;
    }): Promise<{ invoiceSentId: InvoiceSentId, emailId?: EmailId }>;
}