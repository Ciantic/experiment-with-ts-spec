import type { AuditLog, AuditLogId } from "../src/domain/AuditLog.ts";

/**
 * Sample audit entries for a seeded development database. See docs/mockdata.md.
 *
 * The `id` is declared because the entity requires it, but the repository leaves the
 * column to its identity sequence, which assigns 1, 2, 3 in the order the rows are seeded.
 */
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
