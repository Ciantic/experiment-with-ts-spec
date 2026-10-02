/** Unit tests for the REST model, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.ts";
import { buildRestModel } from "./rest-model.ts";

function column(name: string, extras: Partial<Column> = {}): Column {
    // A defaulted column is neither insertable nor patchable, except the version; a fixture that says
    // otherwise passes the flag itself.
    const insertable = extras.insertable ?? extras.default === undefined;
    return { name, sqlType: "text", notNull: true, primaryKey: false, unique: false, insertable, updatable: extras.version === true || insertable, ...extras };
}

function table(name: string, interfaceName: string, columns: Column[]): Table {
    return {
        name,
        interfaceName,
        importSpecifier: `spec/domain/${interfaceName}.ts`,
        columns,
        relations: new Map(),
        sameRowAssignments: [],
        rollups: new Map(),
    };
}

const filterable = table("widget", "Widget", [
    column("id", { primaryKey: true, queryFilter: true }),
    column("size", { queryFilter: true }),
    column("createdAt", { queryOrder: { default: "asc" } }),
    column("amount", { where: ["gte", "lte"] }),
    column("version", { version: true }),
]);

const unfilterable = table("marker", "Marker", [column("id", { primaryKey: true })]);

const tables = new Map([
    ["Widget", filterable],
    ["Marker", unfilterable],
]);

describe("buildRestModel", () => {
    it("keys every entity by its interface name and orders them", () => {
        const model = buildRestModel(tables);

        expect(model.entities.map((entity) => entity.entity)).toEqual(["Marker", "Widget"]);
    });

    it("takes the collection path from the table name", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");

        expect(widget?.path).toBe("/widget");
        expect(widget?.module).toBe("widget");
        expect(widget?.importSpecifier).toBe("spec/domain/Widget.ts");
    });

    it("exposes a read, a write, and a delete for every entity", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");

        expect(widget?.operations.map((operation) => operation.kind)).toEqual([
            "query",
            "create",
            "update",
            "delete",
        ]);
    });

    it("reads with GET and writes with the method each call means", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");

        expect(widget?.operations).toContainEqual({
            kind: "query",
            method: "GET",
            path: "/widget/query",
            source: "query",
        });
        expect(widget?.operations).toContainEqual({
            kind: "create",
            method: "POST",
            path: "/widget",
            source: "body",
        });
        expect(widget?.operations).toContainEqual({
            kind: "update",
            method: "PATCH",
            path: "/widget",
            source: "body",
        });
        expect(widget?.operations).toContainEqual({
            kind: "delete",
            method: "DELETE",
            path: "/widget",
            source: "query",
        });
    });

    it("encodes every call that carries no row data into the query string", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");
        const byKind = new Map(widget?.operations.map((operation) => [operation.kind, operation]));

        expect(byKind.get("query")?.source).toBe("query");
        expect(byKind.get("delete")?.source).toBe("query");
        expect(byKind.get("create")?.source).toBe("body");
        expect(byKind.get("update")?.source).toBe("body");
    });

    it("records the filter fields, the key, and the version fields", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");

        expect(widget?.filters).toEqual(["id", "size"]);
        expect(widget?.key).toBe("id");
        expect(widget?.versionFields).toEqual(["version"]);
    });

    it("records the orderable fields", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");
        const marker = buildRestModel(tables).entities.find((entity) => entity.entity === "Marker");

        expect(widget?.orderFields).toEqual(["createdAt"]);
        expect(marker?.orderFields).toEqual([]);
    });

    it("records the comparable fields with their operators", () => {
        const widget = buildRestModel(tables).entities.find((entity) => entity.entity === "Widget");
        const marker = buildRestModel(tables).entities.find((entity) => entity.entity === "Marker");

        expect(widget?.whereFields).toEqual([{ name: "amount", operators: ["gte", "lte"] }]);
        expect(marker?.whereFields).toEqual([]);
    });
});
