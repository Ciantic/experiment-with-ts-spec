/** Sample domain data for a seeded development database. See docs/mockdata.md. */
import { customers } from "./customer.ts";
import { invoices } from "./invoice.ts";
import { invoiceRows } from "./invoiceRow.ts";
import { invoicesSent } from "./invoiceSent.ts";
import { invoiceSentRows } from "./invoiceSentRow.ts";
import { sellers } from "./seller.ts";
import { translations } from "./translation.ts";

export * from "./customer.ts";
export * from "./seller.ts";
export * from "./invoice.ts";
export * from "./invoiceRow.ts";
export * from "./invoiceSent.ts";
export * from "./invoiceSentRow.ts";
export * from "./translation.ts";

/** One table's rows, named by the spec entity so a seeder can match `create<Entity>`. */
export interface MockTable {
    entity: string;
    rows: unknown[];
}

/** Every mock table, ordered so foreign keys resolve when inserted in sequence. */
export const mockTables: MockTable[] = [
    { entity: "Customer", rows: customers },
    { entity: "Seller", rows: sellers },
    { entity: "Invoice", rows: invoices },
    { entity: "InvoiceRow", rows: invoiceRows },
    { entity: "InvoiceSent", rows: invoicesSent },
    { entity: "InvoiceSentRow", rows: invoiceSentRows },
    { entity: "Translation", rows: translations },
];
