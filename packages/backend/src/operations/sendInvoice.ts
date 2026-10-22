// Generated for implementation by: scripts/generate-operations.ts
import type { InvoiceOperations } from "spec/operations/InvoiceOperations.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import { NotImplemented } from "sdk/errors.ts";

/**
 * Send the invoice to the recipient.
 *
 * @throws {InvoiceDetailsError} when the invoice doesn't have enough details to be sent
 * @throws {NotImplemented} when the operation is still the scaffold; remove this tag with the throw
 */
export const sendInvoice: InvoiceOperations<{ db: SqlExecutor }>["sendInvoice"] = async (ctx, opts) => {
    throw new NotImplemented("sendInvoice is scaffolded but not implemented");
};
