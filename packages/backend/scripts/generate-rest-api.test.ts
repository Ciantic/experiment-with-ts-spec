/** Unit tests for the server route renderer, driven by self-contained fixtures. See docs/testing.md. */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.ts";
import { buildRestModel } from "./rest-model.ts";
import { renderRoutesModule } from "./generate-rest-api.ts";

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
    it("emits a typed route table", () => {
        const code = render();

        expect(code).toContain('import type { Route } from "./router.ts";');
        expect(code).toContain("export const routes: Route[] = [");
    });

    it("names the path, the method, and the schema of each call", () => {
        const code = render();

        expect(code).toContain('path: "/widget/query"');
        expect(code).toContain("input: queryWidgetSchema");
        expect(code).toContain("input: z.array(widgetInsertSchema)");
        expect(code).toContain("input: z.array(widgetPatchSchema)");
    });

    it("validates a write as a batch, since the repository takes rows", () => {
        const code = render();

        expect(code).toContain("input: z.array(widgetInsertSchema)");
        expect(code).toContain("input: z.array(widgetPatchSchema)");
        expect(code).toContain("input: z.array(widgetPrimaryKeySchema)");
    });

    it("reads with GET and says the argument travels in the query string", () => {
        const code = render();

        expect(code).toMatch(/method: "GET",\s*\n\s*path: "\/widget\/query",\s*\n\s*source: "query",/);
    });

    it("posts an entity and patches a patch from the body", () => {
        const code = render();

        expect(code).toMatch(/method: "POST",\s*\n\s*path: "\/widget",\s*\n\s*source: "body",/);
        expect(code).toMatch(/method: "PATCH",\s*\n\s*path: "\/widget",\s*\n\s*source: "body",/);
    });

    it("deletes by the key from the query string", () => {
        const code = render();

        expect(code).toMatch(/method: "DELETE",\s*\n\s*path: "\/widget",\s*\n\s*source: "query",/);
        expect(code).toContain("input: z.array(widgetPrimaryKeySchema)");
    });

    it("wires each route to its generated function", () => {
        const code = render();

        expect(code).toContain("handler: (db, body) => queryWidget(db, body as never)");
        expect(code).toContain("handler: (db, body) => createWidget(db, body as never)");
        expect(code).toContain("handler: (db, body) => updateWidget(db, body as never)");
        expect(code).toContain("handler: (db, body) => deleteWidget(db, body as never)");
    });

    it("imports every generated piece from its barrel", () => {
        const code = render();

        expect(code).toContain('from "../db/queries/index.ts"');
        expect(code).toContain('from "../db/repositories/index.ts"');
        expect(code).toContain('from "validation/index.ts"');
    });

    it("emits no get route", () => {
        const code = render();

        expect(code).not.toContain("getWidgetSchema");
        expect(code).not.toContain("/widget/get");
        expect(code).not.toContain("getMarkerSchema");
        expect(code).not.toContain("/marker/get");
    });

    it("names every import once, sorted", () => {
        const queries = render().match(/import \{ ([^}]+) \} from "\.\.\/db\/queries\/index\.ts"/)?.[1] ?? "";
        const names = queries.split(", ");

        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(new Set(names).size).toBe(names.length);
    });
});
