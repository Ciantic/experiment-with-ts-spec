import type { CustomerId } from "../src/invoicing-service/Customer.ts";
import type { Invoice, InvoiceId } from "../src/invoicing-service/Invoice.ts";
import type { SellerId } from "../src/invoicing-service/Seller.ts";
import type { TenantId } from "../src/invoicing-service/Tenant.ts";
import type { Money } from "../src/invoicing-service/primitives/Money.ts";
import type { Version } from "../src/primitives/Version.ts";

/** Sample invoices for a seeded development database. See docs/mockdata.md. */
export const invoices: Invoice[] = [
    {
        id: "00000000-0000-7000-8000-000000000101" as InvoiceId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        number: "2026-0001",
        customerId: "11111111-1111-7111-8111-111111111111" as CustomerId,
        sellerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa" as SellerId,
        language: "fi",
        issueDate: new Date("2026-01-05T00:00:00.000Z"),
        dueDate: new Date("2026-01-19T00:00:00.000Z"),
        netAmount: "100.00" as Money,
        taxAmount: "25.50" as Money,
        notes: "First invoice of the year.",
        createdAt: new Date("2026-01-05T08:00:00.000Z"),
        updatedAt: new Date("2026-01-05T08:00:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "00000000-0000-7000-8000-000000000102" as InvoiceId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        number: "2026-0002",
        customerId: "22222222-2222-7222-8222-222222222222" as CustomerId,
        sellerId: "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb" as SellerId,
        language: "sv",
        issueDate: new Date("2026-01-12T00:00:00.000Z"),
        dueDate: new Date("2026-01-26T00:00:00.000Z"),
        netAmount: "200.00" as Money,
        taxAmount: "50.00" as Money,
        notes: "",
        createdAt: new Date("2026-01-12T08:00:00.000Z"),
        updatedAt: new Date("2026-01-12T08:00:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "00000000-0000-7000-8000-000000000103" as InvoiceId,
        tenantId: "cccccccc-cccc-7ccc-8ccc-cccccccccccc" as TenantId,
        number: "2026-0003",
        customerId: "33333333-3333-7333-8333-333333333333" as CustomerId,
        sellerId: "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa" as SellerId,
        language: "en",
        issueDate: new Date("2026-02-01T00:00:00.000Z"),
        dueDate: new Date("2026-02-15T00:00:00.000Z"),
        notes: "Draft with no rows yet.",
        createdAt: new Date("2026-02-01T08:00:00.000Z"),
        updatedAt: new Date("2026-02-01T08:00:00.000Z"),
        version: 0n as Version,
    },
];
