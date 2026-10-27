import type { InvoiceSentId } from "../src/invoicing-service/InvoiceSent.ts";
import type { InvoiceSentRow, InvoiceSentRowId } from "../src/invoicing-service/InvoiceSentRow.ts";
import type { TenantId } from "../src/invoicing-service/Tenant.ts";
import type { Money } from "../src/invoicing-service/primitives/Money.ts";
import type { Quantity } from "../src/invoicing-service/primitives/Quantity.ts";
import type { TaxRate } from "../src/invoicing-service/primitives/TaxRate.ts";

/** Sample sent invoice rows for a seeded development database. See docs/mockdata.md. */
export const invoiceSentRows: InvoiceSentRow[] = [
    {
        id: "00000000-0000-7000-8000-000000000401" as InvoiceSentRowId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        invoiceSentId: "00000000-0000-7000-8000-000000000301" as InvoiceSentId,
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
