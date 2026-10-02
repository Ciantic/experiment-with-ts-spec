/** Unit tests for the read resolver, driven by hand-built metadata and PGlite. See docs/testing.md. */
import { beforeAll, describe, expect, it } from "vitest";
import { createPglite } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { createResolver, type QueryModel } from "./resolvers.ts";

/** Fixture entities, so the tests do not read the real spec. */
interface Customer {
    id: string;
    name: string;
    email: string;
}

interface InvoiceRow {
    id: string;
    description: string;
    amount: string;
}

interface Invoice {
    id: string;
    number: string;
    customerId?: string;
    totalAmount: string;
    notes?: string;
    customer?: Customer;
    rows?: InvoiceRow[];
    snapshot?: { name: string; email: string };
}

/** Three tables: a to-one relation, a to-many children branch, and an inlined branch. */
const model: QueryModel = {
    tables: {
        customer: {
            name: "customer",
            key: "id",
            fields: { id: "id", name: "name", email: "email" },
            relations: {},
        },
        invoice: {
            name: "invoice",
            key: "id",
            fields: { id: "id", number: "number", customerId: "customerId", totalAmount: "totalAmount", notes: "notes" },
            relations: {
                customer: { kind: "relation", table: "customer", column: "customerId" },
                rows: { kind: "children", table: "invoice_row", column: "invoiceId" },
                snapshot: { kind: "inlined", columns: { name: "snapshotName", email: "snapshotEmail" } },
            },
        },
        invoice_row: {
            name: "invoice_row",
            key: "id",
            fields: { id: "id", description: "description", amount: "amount" },
            relations: {},
        },
    },
};

const resolver = createResolver(model);
let db: SqlExecutor;

/** A PGlite executor that counts the queries it runs, so batched branches can be asserted. */
function counting(inner: SqlExecutor): SqlExecutor & { count: () => number } {
    let count = 0;
    return {
        count: () => count,
        query: (sql, parameters) => {
            count += 1;
            return inner.query(sql, parameters);
        },
    };
}

beforeAll(async () => {
    const pglite = createPglite();
    await pglite.exec(`
        create table customer (id text primary key, name text not null, email text not null);
        create table invoice (
            id text primary key,
            number text not null,
            "customerId" text references customer(id),
            "totalAmount" text not null,
            notes text,
            "snapshotName" text,
            "snapshotEmail" text
        );
        create table invoice_row (
            id text primary key,
            "invoiceId" text not null references invoice(id),
            description text not null,
            amount text not null
        );
        insert into customer values
            ('c1', 'Acme', 'a@example.com'),
            ('c2', 'Beta', 'b@example.com');
        insert into invoice ("id", "number", "customerId", "totalAmount", "snapshotName", "snapshotEmail", "notes") values
            ('i1', 'INV-1', 'c1', '100', 'Acme AS', 'old@example.com', 'first'),
            ('i2', 'INV-2', 'c2', '200', 'Beta AS', 'beta@example.com', null),
            ('i3', 'INV-3', 'c1', '300', null, null, null),
            ('i4', 'INV-4', null, '400', null, null, null);
        insert into invoice_row ("id", "invoiceId", "description", "amount") values
            ('r1', 'i1', 'Widget', '50'),
            ('r2', 'i1', 'Gadget', '50'),
            ('r3', 'i2', 'Thing', '200');
    `);
    db = pglite;
});

describe("resolveMany", () => {
    it("projects only the selected scalars", async () => {
        const select = { id: true, number: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select });

        expect(rows).toHaveLength(4);
        expect(rows[0]).toEqual({ id: "i1", number: "INV-1" });
    });

    it("omits a selected scalar whose column is null", async () => {
        const select = { id: true, notes: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1", "i2"] }, { select });

        expect(rows).toEqual([{ id: "i1", notes: "first" }, { id: "i2" }]);
    });

    it("omits a null inlined target", async () => {
        const select = { id: true, snapshot: { name: true, email: true } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i4"] }, { select });

        expect(rows).toEqual([{ id: "i4", snapshot: {} }]);
    });

    it("omits a to-one relation whose foreign key is null", async () => {
        const select = { id: true, customer: { name: true } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i4"] }, { select });

        expect(rows).toEqual([{ id: "i4" }]);
    });

    it("reads an inlined branch from the same row, with no extra query", async () => {
        const select = { number: true, snapshot: { name: true } } as const;
        const counted = counting(db);
        const rows = await resolver.resolveMany<Invoice, typeof select>(counted, "invoice", {}, { select });

        expect(rows[0]?.snapshot).toEqual({ name: "Acme AS" });
        expect(counted.count()).toBe(1);
    });

    it("loads a to-one relation in one batched query", async () => {
        const select = { number: true, customer: { name: true } } as const;
        const counted = counting(db);
        const rows = await resolver.resolveMany<Invoice, typeof select>(counted, "invoice", {}, { select });

        expect(rows[0]?.customer).toEqual({ name: "Acme" });
        expect(rows[1]?.customer).toEqual({ name: "Beta" });
        expect(counted.count()).toBe(2);
    });

    it("loads a to-many branch in one batched query and groups it", async () => {
        const select = { number: true, rows: { description: true, amount: true } } as const;
        const counted = counting(db);
        const rows = await resolver.resolveMany<Invoice, typeof select>(counted, "invoice", {}, { select });

        expect(rows[0]?.rows).toEqual([
            { description: "Widget", amount: "50" },
            { description: "Gadget", amount: "50" },
        ]);
        expect(rows[1]?.rows).toEqual([{ description: "Thing", amount: "200" }]);
        expect(rows[2]?.rows).toEqual([]);
        expect(counted.count()).toBe(2);
    });

    it("treats `true` on a branch as all of its scalar fields", async () => {
        const select = { number: true, rows: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i2"] }, { select });

        expect(rows[0]?.rows).toEqual([{ id: "r3", description: "Thing", amount: "200" }]);
    });

    it("matches a set argument against a scalar field", async () => {
        const select = { number: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i3"] }, { select });

        expect(rows).toEqual([{ number: "INV-3" }]);
    });

    it("matches a set argument against a foreign-key field", async () => {
        const select = { id: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(
            db,
            "invoice",
            { customerId: ["c1"] },
            { select },
        );

        expect(rows.map((row) => row.id)).toEqual(["i1", "i3"]);
    });

    it("combines two filters with and", async () => {
        const select = { id: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(
            db,
            "invoice",
            { id: ["i1", "i2"], customerId: ["c1"] },
            { select },
        );

        expect(rows.map((row) => row.id)).toEqual(["i1"]);
    });

    it("returns nothing for an empty set", async () => {
        const select = { id: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: [] }, { select });

        expect(rows).toEqual([]);
    });

    it("rejects a non-array filter", async () => {
        const select = { id: true } as const;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: "i1" }, { select }),
        ).rejects.toThrow("filter `id` on `invoice` must be an array");
    });

    it("returns nothing for a filter that matches no rows", async () => {
        const select = { number: true } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["nope"] }, { select });

        expect(rows).toEqual([]);
    });

    it("rejects an unknown filter field", async () => {
        const select = { number: true } as const;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", { nonsense: [1] }, { select }),
        ).rejects.toThrow("unknown filter field `nonsense` on `invoice`");
    });
});

/** A resolver whose invoice table whitelists ordering fields, with `number asc` as the default. */
const ordered = createResolver({
    tables: {
        invoice: {
            name: "invoice",
            key: "id",
            fields: { id: "id", number: "number", totalAmount: "totalAmount", customerId: "customerId", notes: "notes" },
            relations: {},
            order: ["number", "totalAmount", "customerId"],
            defaultOrder: { field: "number", direction: "asc" },
        },
    },
});

describe("resolveMany ordering", () => {
    const select = { id: true } as const;

    it("orders by a whitelisted field", async () => {
        const rows = await ordered.resolveMany<Invoice, typeof select>(db, "invoice", {}, {
            select,
            order: [["number", "desc"]],
        });

        expect(rows.map((row) => row.id)).toEqual(["i4", "i3", "i2", "i1"]);
    });

    it("applies the entity default ordering when the read names none", async () => {
        const rows = await ordered.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select });

        expect(rows.map((row) => row.id)).toEqual(["i1", "i2", "i3", "i4"]);
    });

    it("orders by several clauses, the first breaking ties", async () => {
        const rows = await ordered.resolveMany<Invoice, typeof select>(db, "invoice", { customerId: ["c1", "c2"] }, {
            select,
            order: [["customerId", "asc"], ["number", "desc"]],
        });

        expect(rows.map((row) => row.id)).toEqual(["i3", "i1", "i2"]);
    });

    it("rejects a field that is not orderable", async () => {
        await expect(
            ordered.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select, order: [["notes", "asc"]] }),
        ).rejects.toThrow("unknown order field `notes` on `invoice`");
    });

    it("rejects a direction that is not asc or desc", async () => {
        await expect(
            ordered.resolveMany<Invoice, typeof select>(db, "invoice", {}, {
                select,
                order: [["number", "up" as never]],
            }),
        ).rejects.toThrow('order direction for `number` on `invoice` must be "asc" or "desc"');
    });
});
