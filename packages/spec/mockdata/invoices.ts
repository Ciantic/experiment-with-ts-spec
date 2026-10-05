import type { CustomerId } from "../src/domain/Customer.ts";
import type { Invoice, InvoiceId } from "../src/domain/Invoice.ts";
import type { SellerId } from "../src/domain/Seller.ts";
import type { Money } from "../src/primitives/Money.ts";

/** Sample invoices for a seeded development database. See docs/mockdata.md. */
export const invoices: Invoice[] = [
    {
        id: "00000000-0000-4000-8000-000000000101" as InvoiceId,
        number: "2026-0001",
        customerId: "11111111-1111-4111-8111-111111111111" as CustomerId,
        sellerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as SellerId,
        language: "fi",
        issueDate: new Date("2026-01-05T00:00:00.000Z"),
        dueDate: new Date("2026-01-19T00:00:00.000Z"),
        netAmount: "100.00" as Money,
        taxAmount: "25.50" as Money,
        notes: "First invoice of the year.",
    },
    {
        id: "00000000-0000-4000-8000-000000000102" as InvoiceId,
        number: "2026-0002",
        customerId: "22222222-2222-4222-8222-222222222222" as CustomerId,
        sellerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as SellerId,
        language: "sv",
        issueDate: new Date("2026-01-12T00:00:00.000Z"),
        dueDate: new Date("2026-01-26T00:00:00.000Z"),
        netAmount: "200.00" as Money,
        taxAmount: "50.00" as Money,
        notes: "",
    },
    {
        id: "00000000-0000-4000-8000-000000000103" as InvoiceId,
        number: "2026-0003",
        customerId: "33333333-3333-4333-8333-333333333333" as CustomerId,
        sellerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as SellerId,
        language: "en",
        issueDate: new Date("2026-02-01T00:00:00.000Z"),
        dueDate: new Date("2026-02-15T00:00:00.000Z"),
        notes: "Draft with no rows yet.",
    },
];
