/** SDK Playground, this is exception to testing rule and is allowed to use domain-specific features */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { EventSource as Polyfill } from "eventsource";
import {
    ApiServer,
    PgliteSqlDriver,
    applySchema,
    createAppContext,
    seedMockData,
} from "infra";
import * as api from "sdk/api/index.ts";
import * as invoiceRows from "sdk/api/invoiceRow.ts";
import { exec, safeExec, transaction } from "sdk/client.ts";
import { ApiClient, VersionConflictError } from "sdk/http.ts";
import type { WatchAllEvent } from "sdk/watch.ts";
import { routes, withoutGuards } from "./routes.ts";
import type { Quantity } from "spec/invoicing-service/primitives/Quantity.ts";
import type { Money } from "spec/invoicing-service/primitives/Money.ts";
import type { TaxRate } from "spec/invoicing-service/primitives/TaxRate.ts";
import type { Version } from "spec/primitives/Version.ts";
import type { InvoiceId } from "spec/invoicing-service/Invoice.ts";
import type { InvoiceRowId } from "spec/invoicing-service/InvoiceRow.ts";

/** The port the playground serves on, so a server you started yourself can be reused. */
const PLAYGROUND_PORT = 3000;

/** Whether anything already accepts connections on the loopback port. */
async function isListening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

/** A fresh v7-shaped identifier, so a run against a long-lived server never collides with an earlier one. */
function uniqueId(): string {
    return `00000000-0000-7000-8000-${randomBytes(6).toString("hex")}`;
}

describe("playground", () => {
    let driver: PgliteSqlDriver | undefined;
    let server: ApiServer | undefined;
    let http: ApiClient;

    beforeAll(async () => {
        // Node gates its own `EventSource` behind `--experimental-eventsource`, so the watch example installs the polyfill. See docs/notifications.md.
        vi.stubGlobal("EventSource", Polyfill);
        if (await isListening(PLAYGROUND_PORT)) {
            http = new ApiClient(`http://127.0.0.1:${PLAYGROUND_PORT}`);
            return;
        }
        driver = new PgliteSqlDriver(PGlite);
        await applySchema(driver);
        await seedMockData(driver.createExecutor());
        server = new ApiServer(createAppContext({ driver }), withoutGuards(routes));
        const port = await server.listen(PLAYGROUND_PORT);
        http = new ApiClient(`http://127.0.0.1:${port}`);
    });

    afterAll(async () => {
        vi.unstubAllGlobals();
        await server?.close();
        await driver?.close();
    });

    it("has a seeded server to try SDK calls against", async () => {
        const [tenant] = await exec(
            http,
            api.queryTenant({ limit: 1, select: { id: true } }),
        );

        if (!tenant) {
            throw new Error("the seed has no tenants");
        }

        const invoiceId = uniqueId() as InvoiceId;
        const invoiceRowId = uniqueId() as InvoiceRowId;
        const number = `2026-${randomBytes(3).toString("hex")}`;
        const invoice: api.InvoiceInsert = {
            id: invoiceId,
            tenantId: tenant.id,
            number,
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
            expect(stored?.number).toBe(number);
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

    it("streams an INSERT through watchInvoice", async () => {
        const [tenant] = await exec(
            http,
            api.queryTenant({ limit: 1, select: { id: true } }),
        );

        if (!tenant) {
            throw new Error("the seed has no tenants");
        }

        const events: WatchAllEvent<"INSERT">[] = [];
        const stream = api.watchInvoice(http, {
            onChange: (event) => events.push(event),
            filter: { tenantId: tenant.id },
            ops: ["INSERT"],
        });

        try {
            // The route flushes its headers before the subscription's `LISTEN` lands, so wait for `open` and then a beat.
            await new Promise<void>((resolve) => {
                stream.addEventListener("open", () => resolve(), { once: true });
            });
            await new Promise((resolve) => setTimeout(resolve, 200));

            const invoice: api.InvoiceInsert = {
                id: uniqueId() as InvoiceId,
                tenantId: tenant.id,
                number: `2026-${randomBytes(3).toString("hex")}`,
                issueDate: new Date("2026-02-01T00:00:00.000Z"),
                dueDate: new Date("2026-02-15T00:00:00.000Z"),
            };
            await exec(http, api.createInvoice([invoice]));

            // `all` carries no key, only the operation, since the trigger publishes the statement.
            await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 5000 });
            expect(events).toEqual([{ op: "INSERT" }]);
        } finally {
            stream.close();
        }
    });

    // Try other calls here; `http`, `exec`, and `safeExec` are ready for the seeded server.
});
