import type { CustomerId } from "../domain/Customer.js";
import type { InvoiceId } from "../domain/Invoice.js";

/**
 * The invoices matching the arguments.
 *
 * @query Invoice many
 */
export type ListInvoices = {
    customerId?: CustomerId;
};

/**
 * One invoice by id.
 *
 * @query Invoice one
 */
export type GetInvoice = {
    id: InvoiceId;
};
