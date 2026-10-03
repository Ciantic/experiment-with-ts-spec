/**
 * End-to-end smoke test: the generated client talks to the seeded server. See
 * docs/mockdata.md.
 *
 * This is the one test that spans the whole stack, so it carries a spec
 * dependency the others avoid (docs/testing.md). Group semantics are not tested
 * here: `src/db/group.test.ts` owns them, and `http/router.test.ts` owns the
 * mapping onto them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as api from "sdk/index.ts";
import type { Executable, HttpClient } from "sdk/index.ts";
import { mockTables } from "spec/mockdata/index.ts";
import type { CustomerId } from "spec/domain/Customer.ts";
import type { InvoiceId } from "spec/domain/Invoice.ts";
import type { Version } from "spec/primitives/Version.ts";
import { startServer, type StartedServer } from "./main.ts";

/** A generated `query<Entity>` builder, seen through the client barrel. */
type QueryFn = (opts: { select: Record<string, never> }) => Executable<unknown[]>;

let started!: StartedServer;
let http!: HttpClient;

beforeAll(async () => {
    started = await startServer({ port: 0, seed: true });
    http = api.createHttpClient(`http://127.0.0.1:${started.port}`);
});

afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
        started.server.close((error) => (error ? reject(error) : resolve()));
    });
    await started.db.close();
});

describe("seeded server", () => {
    it("round-trips every mock table through its generated client call", async () => {
        const calls = api as unknown as Record<string, QueryFn | undefined>;

        for (const { entity, rows } of mockTables) {
            const query = calls[`query${entity}`];
            expect(query, `query${entity} is generated`).toBeTypeOf("function");

            const result = await api.exec(http, query!({ select: {} }));

            expect(result, entity).toHaveLength(rows.length);
        }
    });
});

describe("writes over HTTP", () => {
    let own!: StartedServer;
    let client!: HttpClient;

    const customerId = "11111111-1111-4111-8111-111111111111" as CustomerId;
    const invoiceId = "22222222-2222-4222-8222-222222222222" as InvoiceId;

    beforeAll(async () => {
        own = await startServer({ port: 0, seed: false });
        client = api.createHttpClient(`http://127.0.0.1:${own.port}`);
        await api.exec(
            client,
            api.createCustomer([
                { id: customerId, name: "Acme", email: "a@b.c", address: "Street 1", businessId: "1" },
            ]),
        );
        await api.exec(client, api.createInvoice([{ id: invoiceId, number: "N1", customerId }]));
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            own.server.close((error) => (error ? reject(error) : resolve()));
        });
        await own.db.close();
    });

    it("creates and patches a row through the generated client", async () => {
        await api.exec(client, api.updateInvoice([{ id: invoiceId, version: 0n as Version, notes: "patched" }]));

        const [invoice] = await api.exec(client, api.queryInvoice({ select: { notes: true } }));

        expect(invoice).toMatchObject({ notes: "patched" });
    });

    it("narrows the result to the selection", async () => {
        const [invoice] = await api.exec(client, api.queryInvoice({ select: { notes: true } }));

        const notes: string | undefined = invoice?.notes;
        expect(notes).toBe("patched");
        // @ts-expect-error the selection is the whole of what the result carries
        void invoice?.totalAmount;
    });

    it("rejects a write field the repository never writes", async () => {
        const sent = { id: invoiceId, version: 1n as Version, createdAt: new Date() };

        await expect(api.exec(client, api.updateInvoice([sent]))).rejects.toMatchObject({ status: 400 });
    });

    it("rejects an unknown write field rather than dropping it", async () => {
        const sent = { id: invoiceId, version: 1n as Version, nope: 1 } as never;

        await expect(api.exec(client, api.updateInvoice([sent]))).rejects.toMatchObject({ status: 400 });
    });
});
