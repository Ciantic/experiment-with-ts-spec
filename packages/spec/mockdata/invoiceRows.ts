import type { InvoiceId } from "../src/invoicing-service/Invoice.ts";
import type { InvoiceRow, InvoiceRowId } from "../src/invoicing-service/InvoiceRow.ts";
import type { TenantId } from "../src/invoicing-service/Tenant.ts";
import type { Money } from "../src/invoicing-service/primitives/Money.ts";
import type { Quantity } from "../src/invoicing-service/primitives/Quantity.ts";
import type { TaxRate } from "../src/invoicing-service/primitives/TaxRate.ts";
import type { Version } from "../src/primitives/Version.ts";

/** Sample invoice rows for a seeded development database. See docs/mockdata.md. */
export const invoiceRows: InvoiceRow[] = [
    {
        id: "00000000-0000-7000-8000-000000000201" as InvoiceRowId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        invoiceId: "00000000-0000-7000-8000-000000000101" as InvoiceId,
        description: "Consulting",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.255" as TaxRate,
        createdAt: new Date("2026-01-05T08:05:00.000Z"),
        updatedAt: new Date("2026-01-05T08:05:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "00000000-0000-7000-8000-000000000202" as InvoiceRowId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        invoiceId: "00000000-0000-7000-8000-000000000102" as InvoiceId,
        description: "Support",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.25" as TaxRate,
        createdAt: new Date("2026-01-12T08:05:00.000Z"),
        updatedAt: new Date("2026-01-12T08:05:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "00000000-0000-7000-8000-000000000203" as InvoiceRowId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        invoiceId: "00000000-0000-7000-8000-000000000102" as InvoiceId,
        description: "Training",
        quantity: "10" as Quantity,
        unit: "hours",
        unitPrice: "10.00" as Money,
        taxRate: "0.25" as TaxRate,
        createdAt: new Date("2026-01-12T08:10:00.000Z"),
        updatedAt: new Date("2026-01-12T08:10:00.000Z"),
        version: 0n as Version,
    },
];
