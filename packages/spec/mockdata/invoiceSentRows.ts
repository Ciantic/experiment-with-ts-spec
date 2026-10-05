import type { InvoiceSentId } from "../src/domain/InvoiceSent.ts";
import type { InvoiceSentRow, InvoiceSentRowId } from "../src/domain/InvoiceSentRow.ts";
import type { Money } from "../src/primitives/Money.ts";
import type { Quantity } from "../src/primitives/Quantity.ts";
import type { TaxRate } from "../src/primitives/TaxRate.ts";

/** Sample sent invoice rows for a seeded development database. See docs/mockdata.md. */
export const invoiceSentRows: InvoiceSentRow[] = [
    {
        id: "00000000-0000-4000-8000-000000000401" as InvoiceSentRowId,
        invoiceSentId: "00000000-0000-4000-8000-000000000301" as InvoiceSentId,
        description: "Consulting",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.255" as TaxRate,
        netAmount: "100.00" as Money,
        taxAmount: "25.50" as Money,
        totalAmount: "125.50" as Money,
    },
];
