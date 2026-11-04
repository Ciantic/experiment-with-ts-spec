// Generated for implementation by: scripts/operations/generate-operation-guards.ts
import { ForbiddenError } from "sdk/errors.ts";
import type { RouteGuard } from "infra";
import type { SendInvoiceInput } from "sdk/schemas.ts";

/**
 * Guard `sendInvoice`: the session holds `invoice:send` in the invoice's tenant.
 * @throws {ForbiddenError} when the session lacks `invoice:send` globally or in the invoice's tenant
 */
export const canSendInvoice: RouteGuard<SendInvoiceInput> = async (ctx, argument) => {
    if (await ctx.hasGlobalPermission("invoice", "send")) {
        return;
    }
    const tenant = argument.invoice.tenantId;
    if (!(await ctx.hasTenantPermission("invoice", "send", tenant))) {
        throw new ForbiddenError(`missing permission invoice:send in tenant ${tenant}`);
    }
};
