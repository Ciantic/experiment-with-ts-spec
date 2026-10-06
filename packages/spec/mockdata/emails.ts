import type { Email, EmailId } from "../src/domain/Email.ts";
import type { EmailAddress } from "../src/primitives/EmailAddress.ts";

/** Sample queued emails for a seeded development database. See docs/mockdata.md. */
export const emails: Email[] = [
    {
        id: "00000000-0000-4000-8000-000000000201" as EmailId,
        from: "billing@acme.example" as EmailAddress,
        to: "invoices@acme.example" as EmailAddress,
        subject: "Invoice 2026-0001",
        body: "Hello, invoice 2026-0001 is attached.",
    },
    {
        id: "00000000-0000-4000-8000-000000000202" as EmailId,
        from: "billing@beta.example" as EmailAddress,
        to: "invoices@beta.example" as EmailAddress,
        subject: "Invoice 2026-0002",
        body: "Hello, invoice 2026-0002 is attached.",
        status: "sent",
        sentAt: new Date("2026-01-12T09:30:00.000Z"),
    },
    {
        id: "00000000-0000-4000-8000-000000000203" as EmailId,
        from: "billing@gamma.example" as EmailAddress,
        to: "rechnung@gamma.example" as EmailAddress,
        subject: "Invoice 2026-0003",
        body: "Hello, invoice 2026-0003 is attached.",
        status: "failed",
        attempts: 5n,
        lastError: "SMTP timeout",
    },
];
