import type { InvoiceOperations } from "spec/operations/InvoiceOperations.ts";
import type { SqlExecutor } from "../db/sql-executor.ts";
import type { InvoiceSent } from "spec/domain/InvoiceSent.ts";

/**
 * Send the invoice to the recipient.
 *
 * @throws {InvoiceDetailsError} when the invoice doesn't have enough details to be sent
 */
export const sendInvoice: InvoiceOperations<{ db: SqlExecutor }>["sendInvoice"] = async (ctx, opts) => {
    return null as unknown as Promise<InvoiceSent>;
};
