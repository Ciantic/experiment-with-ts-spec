import type { Customer, CustomerId } from "../src/domain/Customer.ts";
import type { EInvoiceAddress } from "../src/primitives/EInvoiceAddress.ts";
import type { Version } from "../src/primitives/Version.ts";

/** Sample customers for a seeded development database. See docs/mockdata.md. */
export const customers: Customer[] = [
    {
        id: "11111111-1111-4111-8111-111111111111" as CustomerId,
        name: "Acme Oy",
        email: "billing@acme.example",
        address: "Mannerheimintie 1, 00100 Helsinki",
        businessId: "1234567-8",
        eInvoiceAddress: "003712345678" as EInvoiceAddress,
        eInvoiceOperator: "maventa",
        language: "fi",
        createdAt: new Date("2026-01-01T08:00:00.000Z"),
        updatedAt: new Date("2026-01-01T08:00:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "22222222-2222-4222-8222-222222222222" as CustomerId,
        name: "Beta Ab",
        email: "invoices@beta.example",
        address: "Storgatan 2, 00100 Helsingfors",
        businessId: "2345678-9",
        eInvoiceOperator: "op",
        language: "sv",
        createdAt: new Date("2026-01-02T08:00:00.000Z"),
        updatedAt: new Date("2026-01-02T08:00:00.000Z"),
        version: 0n as Version,
    },
    {
        id: "33333333-3333-4333-8333-333333333333" as CustomerId,
        name: "Gamma GmbH",
        email: "rechnung@gamma.example",
        address: "Hauptstrasse 3, 10115 Berlin",
        businessId: "DE123456789",
        language: "en",
        createdAt: new Date("2026-01-03T08:00:00.000Z"),
        updatedAt: new Date("2026-01-03T08:00:00.000Z"),
        version: 0n as Version,
    },
];
