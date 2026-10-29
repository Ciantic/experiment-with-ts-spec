/** Unit tests for the read resolver, driven by hand-built metadata and PGlite. See docs/testing.md. */
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { createPgliteDriver } from "../postgres/pglite-setup.ts";
import type { SqlExecutor } from "./sql-executor.ts";
import { createTransactionalDb } from "./sql-executor.ts";
import type { FilterDefault } from "sdk/selection.ts";
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
            order: ["id"],
            where: { number: ["eq", "gte", "lte"] },
        },
        invoice_row: {
            name: "invoice_row",
            key: "id",
            fields: { id: "id", description: "description", amount: "amount" },
            relations: {},
            order: ["id", "amount"],
            where: { amount: ["eq", "ne", "gt", "gte", "lt", "lte"] },
        },
        widget: {
            name: "widget",
            key: "id",
            fields: { id: "id", seq: "seq" },
            relations: {},
            order: ["id", "seq"],
            where: { seq: ["eq", "ne", "gt", "gte", "lt", "lte"] },
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
        transaction: (run) => inner.transaction(run),
        transactionWith: (options, run) => inner.transactionWith(options, run),
    };
}

beforeAll(async () => {
    const driver = createPgliteDriver(PGlite);
    await driver.exec(`
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
        -- More rows than the default limit, so the cap is observable.
        create table widget (id text primary key, seq int not null);
        insert into widget (id, seq)
            select 'w' || lpad(n::text, 5, '0'), n from generate_series(1, 1500) as n;
        create table task (
            id text primary key,
            status text not null,
            priority int not null,
            "deletedAt" timestamptz
        );
        insert into task (id, status, priority, "deletedAt") values
            ('t1', 'open', 1, null),
            ('t2', 'open', 2, '2026-10-17T12:00:00Z'),
            ('t3', 'done', 0, null);
    `);
    db = createTransactionalDb(driver);
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
        const select = { id: true, snapshot: { select: { name: true, email: true } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i4"] }, { select });

        expect(rows).toEqual([{ id: "i4", snapshot: {} }]);
    });

    it("omits a to-one relation whose foreign key is null", async () => {
        const select = { id: true, customer: { select: { name: true } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i4"] }, { select });

        expect(rows).toEqual([{ id: "i4" }]);
    });

    it("reads an inlined branch from the same row, with no extra query", async () => {
        const select = { number: true, snapshot: { select: { name: true } } } as const;
        const counted = counting(db);
        const rows = await resolver.resolveMany<Invoice, typeof select>(counted, "invoice", {}, { select });

        expect(rows[0]?.snapshot).toEqual({ name: "Acme AS" });
        expect(counted.count()).toBe(1);
    });

    it("loads a to-one relation in one batched query", async () => {
        const select = { number: true, customer: { select: { name: true } } } as const;
        const counted = counting(db);
        const rows = await resolver.resolveMany<Invoice, typeof select>(counted, "invoice", {}, { select });

        expect(rows[0]?.customer).toEqual({ name: "Acme" });
        expect(rows[1]?.customer).toEqual({ name: "Beta" });
        expect(counted.count()).toBe(2);
    });

    it("loads a to-many branch in one batched query and groups it", async () => {
        const select = { number: true, rows: { select: { description: true, amount: true } } } as const;
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
        ).rejects.toThrow("filter `id` on `invoice` must be an array or a null test");
    });

    it("rejects a filter value that is neither a set nor a null test", async () => {
        const select = { id: true } as const;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: { isNull: false } }, { select }),
        ).rejects.toThrow("filter `id` on `invoice` must be an array or a null test");
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

/** A resolver whose invoice table requires a tenant filter on every root read, branch included. */
const scoped = createResolver({
    tables: {
        invoice: {
            name: "invoice",
            key: "id",
            fields: { id: "id", number: "number", customerId: "customerId" },
            relations: { rows: { kind: "children", table: "invoice_row", column: "invoiceId" } },
            requiredFilters: ["customerId"],
        },
        invoice_row: {
            name: "invoice_row",
            key: "id",
            fields: { id: "id", invoiceId: "invoiceId", description: "description", amount: "amount" },
            relations: {},
        },
    },
});

describe("resolveMany required filters", () => {
    it("rejects a root read that leaves out a required filter", async () => {
        const select = { id: true } as const;

        await expect(scoped.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select })).rejects.toThrow(
            "filter `customerId` is required on `invoice`",
        );
    });

    it("rejects a required filter that is named but undefined", async () => {
        const select = { id: true } as const;

        await expect(
            scoped.resolveMany<Invoice, typeof select>(db, "invoice", { customerId: undefined }, { select }),
        ).rejects.toThrow("filter `customerId` is required on `invoice`");
    });

    it("reads when the required filter is named", async () => {
        const select = { id: true } as const;
        const rows = await scoped.resolveMany<Invoice, typeof select>(
            db,
            "invoice",
            { customerId: ["c1"] },
            { select },
        );

        expect(rows.map((row) => row.id)).toEqual(["i1", "i3"]);
    });

    it("leaves a branch fetch alone, because only a root read carries filters", async () => {
        const select = { id: true, rows: { select: { description: true } } } as const;
        const rows = await scoped.resolveMany<Invoice, typeof select>(
            db,
            "invoice",
            { customerId: ["c1"] },
            { select },
        );

        expect(rows[0]?.rows).toEqual([{ description: "Widget" }, { description: "Gadget" }]);
    });
});

/** Resolvers over the `task` fixture, each with the filter defaults one test needs. */
function taskResolver(filterDefaults: Record<string, FilterDefault>) {
    return createResolver({
        tables: {
            task: {
                name: "task",
                key: "id",
                fields: { id: "id", status: "status", priority: "priority", deletedAt: "deletedAt" },
                relations: {},
                order: ["id"],
                filterDefaults,
            },
        },
    });
}

describe("resolveMany filter defaults", () => {
    const select = { id: true } as const;
    const ids = async (resolver: ReturnType<typeof taskResolver>, args: Record<string, unknown>) => {
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(db, "task", args, { select });
        return rows.map((row) => row.id);
    };

    it("matches null when a defaulted filter is omitted", async () => {
        expect(await ids(taskResolver({ deletedAt: { kind: "isNull" } }), {})).toEqual(["t1", "t3"]);
    });

    it("matches a declared string when the filter is omitted", async () => {
        expect(await ids(taskResolver({ status: { kind: "literal", value: "open" } }), {})).toEqual(["t1", "t2"]);
    });

    it("binds a literal against the column's type, so a date string matches a timestamp column", async () => {
        expect(await ids(taskResolver({ deletedAt: { kind: "literal", value: "2026-10-17T12:00:00Z" } }), {})).toEqual(["t2"]);
    });

    it("matches a declared number when the filter is omitted", async () => {
        expect(await ids(taskResolver({ priority: { kind: "literal", value: 0 } }), {})).toEqual(["t3"]);
    });

    it("lets a named filter override the default", async () => {
        expect(await ids(taskResolver({ status: { kind: "literal", value: "open" } }), { status: ["done"] })).toEqual(["t3"]);
    });

    it("combines two defaults with and", async () => {
        expect(await ids(taskResolver({ status: { kind: "literal", value: "open" }, priority: { kind: "literal", value: 2 } }), {})).toEqual(["t2"]);
    });

    it("combines a default with a named filter", async () => {
        expect(await ids(taskResolver({ deletedAt: { kind: "isNull" } }), { status: ["done"] })).toEqual(["t3"]);
    });

    it("matches nulls with an `isNull` filter", async () => {
        expect(await ids(taskResolver({}), { deletedAt: { isNull: true } })).toEqual(["t1", "t3"]);
    });

    it("matches rows with a value with an `isNotNull` filter, overriding the default", async () => {
        expect(await ids(taskResolver({ deletedAt: { kind: "isNull" } }), { deletedAt: { isNotNull: true } })).toEqual(["t2"]);
    });

    it("rejects an unknown null test", async () => {
        await expect(ids(taskResolver({}), { deletedAt: { isMaybe: true } })).rejects.toThrow(
            "filter `deletedAt` on `task` must be an array or a null test",
        );
    });

    it("filters with a `where` null test instead of a value", async () => {
        const resolver = createResolver({
            tables: {
                task: {
                    name: "task",
                    key: "id",
                    fields: { id: "id", deletedAt: "deletedAt" },
                    relations: {},
                    order: ["id"],
                    where: { deletedAt: ["isNull", "isNotNull"] },
                },
            },
        });
        const read = async (where: Record<string, Record<string, unknown>>) =>
            (
                await resolver.resolveMany<{ id: string }, typeof select>(db, "task", {}, { select, where })
            ).map((row) => row.id);

        expect(await read({ deletedAt: { isNull: true } })).toEqual(["t1", "t3"]);
        expect(await read({ deletedAt: { isNotNull: true } })).toEqual(["t2"]);
    });

    it("rejects a `where` null test that passes a value", async () => {
        const resolver = createResolver({
            tables: {
                task: {
                    name: "task",
                    key: "id",
                    fields: { id: "id", deletedAt: "deletedAt" },
                    relations: {},
                    order: ["id"],
                    where: { deletedAt: ["isNull"] },
                },
            },
        });

        await expect(
            resolver.resolveMany<{ id: string }, typeof select>(
                db,
                "task",
                {},
                { select, where: { deletedAt: { isNull: false } } },
            ),
        ).rejects.toThrow("where operator `isNull` on `deletedAt` of `task` takes `true`");
    });

    it("lets a comparison on the same field override the default", async () => {
        const resolver = createResolver({
            tables: {
                task: {
                    name: "task",
                    key: "id",
                    fields: { id: "id", deletedAt: "deletedAt" },
                    relations: {},
                    order: ["id"],
                    where: { deletedAt: ["gte"] },
                    filterDefaults: { deletedAt: { kind: "isNull" } },
                },
            },
        });
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(
            db,
            "task",
            {},
            { select, where: { deletedAt: { gte: new Date(0) } } },
        );

        expect(rows.map((row) => row.id)).toEqual(["t2"]);
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

describe("resolveMany sets", () => {
    it("binds a set as one array parameter, so its size is not bounded by the parameter limit", async () => {
        const select = { id: true } as const;
        const ids = Array.from({ length: 40000 }, (_, index) => `w${String(index + 1).padStart(5, "0")}`);
        const counted = counting(db);

        const rows = await resolver.resolveMany<{ id: string }, typeof select>(counted, "widget", { id: ids }, {
            select,
            limit: 2000,
        });

        expect(rows).toHaveLength(1500);
        expect(counted.count()).toBe(1);
    });
});

describe("resolveMany paging", () => {
    const select = { id: true } as const;
    const ids = (rows: { id?: string }[]) => rows.map((row) => row.id);

    it("caps a read that names no limit at the default", async () => {
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, { select });

        expect(rows).toHaveLength(1000);
    });

    it("returns at most `limit` rows", async () => {
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, {
            select,
            limit: 3,
        });

        expect(ids(rows)).toEqual(["w00001", "w00002", "w00003"]);
    });

    it("raises the cap above the default when `limit` is larger", async () => {
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, {
            select,
            limit: 2000,
        });

        expect(rows).toHaveLength(1500);
    });

    it("skips `offset` leading rows", async () => {
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, {
            select,
            order: [["id", "asc"]],
            limit: 2,
            offset: 5,
        });

        expect(ids(rows)).toEqual(["w00006", "w00007"]);
    });

    it("applies `offset` on its own with the default limit", async () => {
        const rows = await resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, {
            select,
            order: [["id", "asc"]],
            offset: 1495,
        });

        expect(ids(rows)).toEqual(["w01496", "w01497", "w01498", "w01499", "w01500"]);
    });

    it("does not page a branch, only the root", async () => {
        const selectWithRows = { id: true, rows: { select: { id: true } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof selectWithRows>(db, "invoice", {}, {
            select: selectWithRows,
            limit: 1,
            offset: 0,
            order: [["id", "asc"]],
        });

        expect(rows).toHaveLength(1);
        expect(rows[0]?.rows).toHaveLength(2);
    });

    it("rejects a limit that is not a positive integer", async () => {
        await expect(
            resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, { select, limit: 0 }),
        ).rejects.toThrow("limit must be a positive integer, found `0`");
    });

    it("rejects a step that is not a whole number", async () => {
        await expect(
            resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, { select, limit: 2.5 }),
        ).rejects.toThrow("limit must be a positive integer, found `2.5`");
    });

    it("rejects a negative offset", async () => {
        await expect(
            resolver.resolveMany<{ id: string }, typeof select>(db, "widget", {}, { select, offset: -1 }),
        ).rejects.toThrow("offset must be a non-negative integer, found `-1`");
    });
});

describe("resolveMany where", () => {
    const select = { id: true } as const;
    const ids = (rows: { id?: string }[]) => rows.map((row) => row.id);
    const widget = (condition: Record<string, unknown>, args: Record<string, unknown> = {}) =>
        resolver.resolveMany<{ id: string }, typeof select>(db, "widget", args, {
            select,
            order: [["seq", "asc"]],
            where: { seq: condition },
        });

    it("filters with a comparison", async () => {
        const rows = await widget({ gt: 1498 });

        expect(ids(rows)).toEqual(["w01499", "w01500"]);
    });

    it("treats several operators on one field as a range", async () => {
        const rows = await widget({ gte: 4, lte: 6 });

        expect(ids(rows)).toEqual(["w00004", "w00005", "w00006"]);
    });

    it("filters with ne", async () => {
        const rows = await widget({ gte: 1, ne: 1 }, { id: ["w00001", "w00002", "w00003"] });

        expect(ids(rows)).toEqual(["w00002", "w00003"]);
    });

    it("combines a filter set and a comparison with and", async () => {
        const rows = await widget({ gte: 2 }, { id: ["w00001", "w00002", "w00003"] });

        expect(ids(rows)).toEqual(["w00002", "w00003"]);
    });

    it("rejects a field that is not comparable", async () => {
        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, {
                select,
                where: { nonsense: { eq: 1 } },
            }),
        ).rejects.toThrow("unknown where field `nonsense` on `invoice`");
    });

    it("rejects an operator the field does not whitelist", async () => {
        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, {
                select,
                where: { number: { gt: "INV-1" } },
            }),
        ).rejects.toThrow("where operator `gt` is not allowed on `number` of `invoice`");
    });

    it("rejects an operator that is not a comparison at all", async () => {
        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, {
                select,
                where: { number: { between: "x" } },
            }),
        ).rejects.toThrow("where operator `between` is not allowed on `number` of `invoice`");
    });

    it("leaves a branch unfiltered by a root comparison", async () => {
        const selectWithRows = { id: true, rows: { select: { id: true } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof selectWithRows>(db, "invoice", {}, {
            select: selectWithRows,
            order: [["id", "asc"]],
            where: { number: { gte: "INV-2" } },
        });

        expect(rows.map((row) => row.id)).toEqual(["i2", "i3", "i4"]);
        expect(rows[0]?.rows).toHaveLength(1);
    });
});

describe("resolveMany branch arguments", () => {
    it("filters a branch with its own filter set", async () => {
        const select = { id: true, rows: { select: { amount: true }, filter: { description: ["Widget"] } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1"] }, { select });

        expect(rows[0]?.rows).toEqual([{ amount: "50" }]);
    });

    it("filters a branch with its own comparison", async () => {
        const select = { id: true, rows: { select: { id: true }, where: { amount: { eq: "200" } } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1", "i2"] }, { select });

        expect(rows[0]?.rows).toEqual([]);
        expect(rows[1]?.rows).toEqual([{ id: "r3" }]);
    });

    it("orders a branch with its own clauses", async () => {
        const select = {
            id: true,
            rows: { select: { id: true }, order: [["amount", "desc"], ["id", "asc"]] },
        } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1"] }, { select });

        expect(rows[0]?.rows).toEqual([{ id: "r1" }, { id: "r2" }]);
    });

    it("pages each parent's rows independently", async () => {
        const select = { id: true, rows: { select: { id: true }, order: [["id", "asc"]], limit: 1 } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1", "i2"] }, { select });

        expect(rows[0]?.rows).toEqual([{ id: "r1" }]);
        expect(rows[1]?.rows).toEqual([{ id: "r3" }]);
    });

    it("skips a branch offset within each parent", async () => {
        const select = { id: true, rows: { select: { id: true }, order: [["id", "asc"]], offset: 1 } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1", "i2"] }, { select });

        expect(rows[0]?.rows).toEqual([{ id: "r2" }]);
        expect(rows[1]?.rows).toEqual([]);
    });

    it("filters a to-one relation branch", async () => {
        const select = { id: true, customer: { select: { name: true }, filter: { name: ["Beta"] } } } as const;
        const rows = await resolver.resolveMany<Invoice, typeof select>(db, "invoice", { id: ["i1", "i2"] }, { select });

        expect(rows[0]).toEqual({ id: "i1" });
        expect(rows[1]?.customer).toEqual({ name: "Beta" });
    });

    it("rejects a branch without a select", async () => {
        const select = { id: true, rows: { filter: { id: ["r1"] } } } as never;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select }),
        ).rejects.toThrow("branch `invoice.rows` needs a `select`");
    });

    it("rejects a branch filter that names no column", async () => {
        const select = { id: true, rows: { select: { id: true }, filter: { nonsense: ["x"] } } } as never;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select }),
        ).rejects.toThrow("unknown filter field `nonsense` on `invoice_row`");
    });

    it("rejects a branch order field the target does not whitelist", async () => {
        const select = { id: true, rows: { select: { id: true }, order: [["description", "asc"]] } } as never;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select }),
        ).rejects.toThrow("unknown order field `description` on `invoice_row`");
    });

    it("rejects a branch limit that is not a positive integer", async () => {
        const select = { id: true, rows: { select: { id: true }, limit: 0 } } as never;

        await expect(
            resolver.resolveMany<Invoice, typeof select>(db, "invoice", {}, { select }),
        ).rejects.toThrow("limit on `invoice.rows` must be a positive integer, found `0`");
    });
});
