import type { Invoice } from "../domain/Invoice.ts";
import type { InvoiceSent } from "../domain/InvoiceSent.ts";

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
    }): Promise<InvoiceSent>;

    /**
     * Receive an invoice from the system.
     * 
     * @operation
     * @restOperation POST /invoice/receive
     */
    receiveInvoice(ctx: T): Promise<void>;
}