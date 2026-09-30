import type { InvoiceId } from "../src/domain/Invoice.ts";
import type { InvoiceRow, InvoiceRowId } from "../src/domain/InvoiceRow.ts";
import type { Money } from "../src/primitives/Money.ts";
import type { Quantity } from "../src/primitives/Quantity.ts";
import type { TaxRate } from "../src/primitives/TaxRate.ts";

/** Sample invoice rows for a seeded development database. See docs/mockdata.md. */
export const invoiceRows: InvoiceRow[] = [
    {
        id: "00000000-0000-4000-8000-000000000201" as InvoiceRowId,
        invoiceId: "00000000-0000-4000-8000-000000000101" as InvoiceId,
        description: "Consulting",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.255" as TaxRate,
    },
    {
        id: "00000000-0000-4000-8000-000000000202" as InvoiceRowId,
        invoiceId: "00000000-0000-4000-8000-000000000102" as InvoiceId,
        description: "Support",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.25" as TaxRate,
    },
    {
        id: "00000000-0000-4000-8000-000000000203" as InvoiceRowId,
        invoiceId: "00000000-0000-4000-8000-000000000102" as InvoiceId,
        description: "Training",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.25" as TaxRate,
    },
];
