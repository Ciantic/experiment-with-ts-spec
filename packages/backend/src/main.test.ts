/** End-to-end smoke test: the generated client talks to the seeded server. See docs/mockdata.md. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as api from "sdk/index.ts";
import type { Executable, HttpClient } from "sdk/index.ts";
import type { HttpError } from "sdk/http.ts";
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

describe("groups over HTTP", () => {
    let own!: StartedServer;
    let client!: HttpClient;

    const kept = "33333333-3333-4333-8333-333333333333" as CustomerId;
    const ghost = "44444444-4444-4444-8444-444444444444" as CustomerId;
    const doomed = "66666666-6666-4666-8666-666666666666" as CustomerId;
    const missing = "55555555-5555-4555-8555-555555555555" as CustomerId;

    const keptInvoice = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2" as InvoiceId;
    const ghostInvoice = "a3a3a3a3-a3a3-4a3a-8a3a-a3a3a3a3a3a3" as InvoiceId;
    const doomedInvoice = "a4a4a4a4-a4a4-4a4a-8a4a-a4a4a4a4a4a4" as InvoiceId;
    const nested = "77777777-7777-4777-8777-777777777777" as CustomerId;
    const nestedInvoice = "a5a5a5a5-a5a5-4a5a-8a5a-a5a5a5a5a5a5" as InvoiceId;
    const victimInvoice = "a6a6a6a6-a6a6-4a6a-8a6a-a6a6a6a6a6a6" as InvoiceId;
    const lonelyInvoice = "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7" as InvoiceId;
    const patient = "b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1" as CustomerId;

    /** A customer insert, which the two rollback tests vary by id. */
    function customer(id: CustomerId, name: string) {
        return { id, name, email: `${name.toLowerCase()}@b.c`, address: "Street 2", businessId: "2" };
    }

    /** An insert whose foreign key names no customer, so the write raises 23503. */
    function orphanInvoice(id: InvoiceId, number: string) {
        return { id, number, customerId: missing };
    }

    /** Run a group that is expected to fail, and answer the failure. */
    async function failure(executable: Executable<void>): Promise<HttpError> {
        return (await api.exec(client, executable).catch((thrown: unknown) => thrown)) as HttpError;
    }

    beforeAll(async () => {
        own = await startServer({ port: 0, seed: false });
        client = api.createHttpClient(`http://127.0.0.1:${own.port}`);
    });

    afterAll(async () => {
        await new Promise<void>((resolve, reject) => {
            own.server.close((error) => (error ? reject(error) : resolve()));
        });
        await own.db.close();
    });

    it("commits a transaction group, and reads it back in one round trip", async () => {
        await api.exec(
            client,
            api.transaction(
                api.createCustomer([customer(kept, "Kept")]),
                api.createInvoice([{ id: keptInvoice, number: "N2", customerId: kept }]),
            ),
        );

        const [customers, invoices] = await api.exec(
            client,
            api.batch(
                api.queryCustomer({ filter: { id: [kept] }, select: { name: true } }),
                api.queryInvoice({ filter: { id: [keptInvoice] }, select: { number: true } }),
            ),
        );

        expect(customers).toMatchObject([{ name: "Kept" }]);
        expect(invoices).toMatchObject([{ number: "N2" }]);
    });

    it("rolls a transaction back whole when one entry fails", async () => {
        const result = await failure(
            api.transaction(
                api.createCustomer([customer(ghost, "Ghost")]),
                api.createInvoice([orphanInvoice(ghostInvoice, "N3")]),
            ),
        );

        expect(result.status).toBe(409);
        expect(result.path).toEqual([1]);

        const rows = await api.exec(client, api.queryCustomer({ filter: { id: [ghost] }, select: { id: true } }));
        expect(rows).toHaveLength(0);
    });

    it("rolls a nested transaction back with the outer one when the outer fails", async () => {
        const result = await failure(
            api.transaction(
                api.transaction(api.createCustomer([customer(nested, "Nested")])),
                api.createInvoice([orphanInvoice(nestedInvoice, "N5")]),
            ),
        );

        expect(result.status).toBe(409);
        expect(result.path).toEqual([1]);

        const rows = await api.exec(client, api.queryCustomer({ filter: { id: [nested] }, select: { id: true } }));
        expect(rows).toHaveLength(0);
    });

    it("keeps what a tolerated failure did not touch, and the outer group still commits", async () => {
        const survivor = "88888888-8888-4888-8888-888888888888" as CustomerId;
        const victim = "99999999-9999-4999-8999-999999999999" as CustomerId;

        const [first, recovery, last] = await api.exec(
            client,
            api.transaction(
                api.createCustomer([customer(survivor, "Survivor")]),
                api.attempt(api.createCustomer([customer(victim, "Victim")]), api.createInvoice([orphanInvoice(victimInvoice, "N6")])),
                api.createCustomer([customer(patient, "Patient")]),
            ),
        );

        expect(recovery.ok).toBe(false);
        expect(first).toBeNull();
        expect(last).toBeNull();

        const rows = await api.exec(
            client,
            api.queryCustomer({ filter: { id: [survivor, victim, patient] }, select: { id: true } }),
        );
        // The survivor and the entry after the tolerated failure committed; the victim's group did not.
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.id)).not.toContain(victim);
    });

    it("reports a tolerated failure without failing the request", async () => {
        const outcome = await api.exec(
            client,
            api.attempt(api.createInvoice([orphanInvoice(lonelyInvoice, "N7")])),
        );

        expect(outcome.ok).toBe(false);
        expect(outcome.ok === false && outcome.error.path).toEqual([0]);

        const rows = await api.exec(client, api.queryInvoice({ filter: { id: [lonelyInvoice] }, select: { id: true } }));
        expect(rows).toHaveLength(0);
    });

    it("keeps a batch's earlier writes when a later entry fails", async () => {
        const result = await failure(
            api.batch(
                api.createCustomer([customer(doomed, "Doomed")]),
                api.createInvoice([orphanInvoice(doomedInvoice, "N4")]),
            ),
        );

        expect(result.status).toBe(409);
        expect(result.path).toEqual([1]);

        const rows = await api.exec(client, api.queryCustomer({ filter: { id: [doomed] }, select: { id: true } }));
        expect(rows).toHaveLength(1);
    });
});
