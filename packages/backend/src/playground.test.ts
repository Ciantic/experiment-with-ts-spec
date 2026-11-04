/** SDK Playground, this is exception to testing rule and is allowed to use domain-specific features */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
    ApiServer,
    PgliteSqlDriver,
    applySchema,
    createAppContext,
    seedMockData,
    type Route,
} from "infra";
import * as api from "sdk/api/index.ts";
import * as invoiceRows from "sdk/api/invoiceRow.ts";
import { exec, safeExec, transaction } from "sdk/client.ts";
import { ApiClient, VersionConflictError } from "sdk/http.ts";
import { routes } from "./routes.ts";
import type { Quantity } from "spec/invoicing-service/primitives/Quantity.ts";
import type { Money } from "spec/invoicing-service/primitives/Money.ts";
import type { TaxRate } from "spec/invoicing-service/primitives/TaxRate.ts";
import type { Version } from "spec/primitives/Version.ts";
import type { InvoiceId } from "spec/invoicing-service/Invoice.ts";
import type { InvoiceRowId } from "spec/invoicing-service/InvoiceRow.ts";

/** The generated routes without guards: the permission layer still throws `NotImplemented`, so a guarded call would only see 501. */
function withoutGuard(route: Route): Route {
    const copy: Route = { ...route };
    delete copy.guard;
    return copy;
}

describe("playground", () => {
    let driver: PgliteSqlDriver;
    let server: ApiServer;
    let http: ApiClient;

    beforeAll(async () => {
        driver = new PgliteSqlDriver(PGlite);
        await applySchema(driver);
        await seedMockData(driver.createExecutor());
        server = new ApiServer(createAppContext({ driver }), routes.map(withoutGuard));
        const port = await server.listen(0);
        http = new ApiClient(`http://127.0.0.1:${port}`);
    });

    afterAll(async () => {
        await server.close();
        await driver.close();
    });

    it("has a seeded server to try SDK calls against", async () => {
        const [tenant] = await exec(
            http,
            api.queryTenant({ limit: 1, select: { id: true } }),
        );

        if (!tenant) {
            throw new Error("the seed has no tenants");
        }

        const invoiceId = "00000000-0000-7000-8000-0000000009ff" as InvoiceId;
        const invoiceRowId = "00000000-0000-7000-8000-0000000009f1" as InvoiceRowId;
        const invoice: api.InvoiceInsert = {
            id: invoiceId,
            tenantId: tenant.id,
            number: "2026-9001",
            issueDate: new Date("2026-02-01T00:00:00.000Z"),
            dueDate: new Date("2026-02-15T00:00:00.000Z"),
        };
        const invoiceRow: invoiceRows.InvoiceRowInsert = {
            id: invoiceRowId,
            tenantId: tenant.id,
            invoiceId,
            description: "Playground line",
            quantity: "2" as Quantity,
            unit: "pieces",
            unitPrice: "50.00" as Money,
            taxRate: "0.255" as TaxRate,
        };

        // Insert the invoice and one row, then read the totals the triggers computed, all in one transaction.
        const outcome2 = await safeExec(
            http,
            transaction(
                api.createInvoice([invoice]),
                invoiceRows.createInvoiceRow([invoiceRow]),
                api.queryInvoice({
                    filter: { id: [invoiceId] },
                    select: { id: true, number: true, netAmount: true, taxAmount: true },
                }),
            ),
        );
        expect(outcome2.ok).toBe(true);
        if (outcome2.ok) {
            const [, createdRows, [stored]] = outcome2.value;
            expect(createdRows).toHaveLength(1);
            expect(stored?.number).toBe("2026-9001");
            expect(stored?.netAmount).toBe("100.00");
            expect(stored?.taxAmount).toBe("25.50");
        }
    });

    it("returns the error when a versioned update addresses no row", async () => {
        const missingId = "00000000-0000-7000-8000-0000000009fe" as NonNullable<api.InvoiceInsert["id"]>;

        const outcome = await safeExec(
            http,
            api.updateInvoice([{ id: missingId, version: -1n as Version }]),
        );

        expect(outcome.ok).toBe(false);
        if (!outcome.ok) {
            expect(outcome.error).toBeInstanceOf(VersionConflictError);
            if (outcome.error instanceof VersionConflictError) {
                expect(outcome.error.status).toBe(409);
            }
        }
    });

    // Try other calls here; `http`, `exec`, and `safeExec` are ready for the seeded server.
});
