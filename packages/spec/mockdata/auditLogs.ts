import type { AuditLog, AuditLogId } from "../src/invoicing-service/AuditLog.ts";

/** Sample audit entries for a seeded development database; the identity sequence assigns the ids. See docs/mockdata.md. */
export const auditLogs: AuditLog[] = [
    {
        id: 1 as AuditLogId,
        message: "Invoice 2026-0001 issued.",
        createdAt: new Date("2026-01-05T08:00:00.000Z"),
    },
    {
        id: 2 as AuditLogId,
        message: "Invoice 2026-0001 sent to billing@acme.example.",
        createdAt: new Date("2026-01-05T09:30:00.000Z"),
    },
    {
        id: 3 as AuditLogId,
        message: "Invoice 2026-0002 issued.",
        createdAt: new Date("2026-01-12T08:00:00.000Z"),
    },
];
