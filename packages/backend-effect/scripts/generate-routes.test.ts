/** Unit tests for the Effect route renderer, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.ts";
import { buildRestModel } from "./rest-model.ts";
import { renderRoutesModule } from "./generate-routes.ts";

function column(name: string, extras: Partial<Column> = {}): Column {
    return { name, sqlType: "text", notNull: true, primaryKey: false, unique: false, ...extras };
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

const widget = table("widget", "Widget", [
    column("id", { primaryKey: true, queryFilter: true }),
    column("version", { version: true }),
]);

const marker = table("marker", "Marker", [column("id", { primaryKey: true })]);

const tables = new Map([
    ["Marker", marker],
    ["Widget", widget],
]);

function render(): string {
    return renderRoutesModule(buildRestModel(tables));
}

describe("renderRoutesModule", () => {
    it("emits a typed route table importing the router contract", () => {
        const code = render();

        expect(code).toContain('import type { Route } from "./router.ts";');
        expect(code).toContain("export const routes: Route[] = [");
    });

    it("names the path, the method, and the schema of each call", () => {
        const code = render();

        expect(code).toContain('path: "/widget/query"');
        expect(code).toContain("input: listWidgetSchema");
        expect(code).toContain("input: getWidgetSchema");
        expect(code).toContain("input: widgetSchema");
        expect(code).toContain("input: widgetPatchSchema");
    });

    it("reads with GET and says the argument travels in the query string", () => {
        const code = render();

        expect(code).toMatch(/method: "GET",\s*\n\s*path: "\/widget\/query",\s*\n\s*source: "query",/);
        expect(code).toMatch(/method: "GET",\s*\n\s*path: "\/widget\/get",\s*\n\s*source: "query",/);
    });

    it("posts an entity and patches a patch from the body", () => {
        const code = render();

        expect(code).toMatch(/method: "POST",\s*\n\s*path: "\/widget",\s*\n\s*source: "body",/);
        expect(code).toMatch(/method: "PATCH",\s*\n\s*path: "\/widget",\s*\n\s*source: "body",/);
    });

    it("deletes by the key from the query string, projecting the entity schema to the key", () => {
        const code = render();

        expect(code).toMatch(/method: "DELETE",\s*\n\s*path: "\/widget",\s*\n\s*source: "query",/);
        expect(code).toContain("input: Schema.Array(Schema.Struct({ id: widgetSchema.fields.id }))");
    });

    it("wires each route to its generated function with the body only", () => {
        const code = render();

        expect(code).toContain("handler: (body) => listWidget(body as never)");
        expect(code).toContain("handler: (body) => createWidget(body as never)");
        expect(code).toContain("handler: (body) => updateWidget(body as never)");
        expect(code).toContain("handler: (body) => deleteWidget(body as never)");
    });

    it("imports every generated piece from its barrel and effect", () => {
        const code = render();

        expect(code).toContain('import { Schema } from "effect";');
        expect(code).toContain('from "../db/queries/index.ts"');
        expect(code).toContain('from "../db/repositories/index.ts"');
        expect(code).toContain('from "../validation/index.ts"');
    });

    it("emits no getter for an entity that cannot name a row", () => {
        const code = render();

        expect(code).toContain("input: listMarkerSchema");
        expect(code).toContain('path: "/marker/query"');
        expect(code).not.toContain("getMarkerSchema");
        expect(code).not.toContain('path: "/marker/get"');
    });

    it("names every import once, sorted", () => {
        const queries = render().match(/import \{ ([^}]+) \} from "\.\.\/db\/queries\/index\.ts"/)?.[1] ?? "";
        const names = queries.split(", ");

        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(new Set(names).size).toBe(names.length);
    });
});
