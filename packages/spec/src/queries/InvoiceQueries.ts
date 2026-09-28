import type { CustomerId } from "../domain/Customer.js";
import type { Invoice, InvoiceId } from "../domain/Invoice.js";
import type { Selection, Selected } from "./selection.js";

/** Narrows the invoices a list returns. See docs/queries.md. */
export type InvoiceFilter = {
    customerId?: CustomerId;
    issuedFrom?: Date;
    issuedTo?: Date;
};

/** Options for {@link InvoiceQueries.getInvoice}. */
export interface GetInvoiceOptions<S extends Selection<Invoice>> {
    /** The fields to read. */
    select: S;
}

/** Options for {@link InvoiceQueries.listInvoices}. */
export interface ListInvoicesOptions<S extends Selection<Invoice>> {
    /** The fields to read. */
    select: S;
    /** Narrows the invoices returned. */
    filter?: InvoiceFilter;
}

/** Reads invoices; the contract an implementation in the backend satisfies. See docs/queries.md. */
export interface InvoiceQueries {
    /** One invoice by id, or undefined when there is none. */
    getInvoice<S extends Selection<Invoice>>(
        id: InvoiceId,
        opts: GetInvoiceOptions<S>,
    ): Promise<Selected<Invoice, S> | undefined>;

    /** The invoices matching the filter, or all of them when none is given. */
    listInvoices<S extends Selection<Invoice>>(
        opts: ListInvoicesOptions<S>,
    ): Promise<Selected<Invoice, S>[]>;
}
