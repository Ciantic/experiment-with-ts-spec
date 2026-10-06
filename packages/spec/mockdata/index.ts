/** Sample domain data for a seeded development database. See docs/mockdata.md. */
import { customers } from "./customers.ts";
import { emails } from "./emails.ts";
import { invoices } from "./invoices.ts";
import { invoiceRows } from "./invoiceRows.ts";
import { invoicesSent } from "./invoicesSent.ts";
import { invoiceSentRows } from "./invoiceSentRows.ts";
import { sellers } from "./sellers.ts";
import { translations } from "./translations.ts";

export * from "./customers.ts";
export * from "./sellers.ts";
export * from "./invoices.ts";
export * from "./invoiceRows.ts";
export * from "./invoicesSent.ts";
export * from "./invoiceSentRows.ts";
export * from "./emails.ts";
export * from "./translations.ts";

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
    { entity: "Email", rows: emails },
    { entity: "Translation", rows: translations },
];
