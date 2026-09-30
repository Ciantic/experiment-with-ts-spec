import type { CustomerId } from "../domain/Customer.js";
import type { InvoiceId } from "../domain/Invoice.js";

/**
 * The invoices matching the arguments.
 *
 * @query Customer many
 */
export type ListCustomers = {
};

/**
 * One customer by id.
 *
 * @query Customer one
 */
export type GetCustomer = {
    id: CustomerId;
};

/**
 * Multiple customers by their ids.
 * 
 * @query Customer many
 */
export type GetCustomers = {
    /**
     * @in id
     */
    ids: CustomerId[];
};
