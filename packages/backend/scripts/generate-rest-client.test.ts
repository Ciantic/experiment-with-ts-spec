/**
 * Unit tests for the client renderer, driven by self-contained fixtures.
 * See docs/testing.md.
 *
 * The last group is the invariant that makes the client worth generating: it may
 * import `spec`, the shared `validation` types, and its own modules, and nothing
 * else. Both generators are then driven from one model and the calls they expose
 * are compared, so the two cannot disagree about the wire.
 */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.ts";
import { buildRestModel } from "./rest-model.ts";
import { generateRestClient, renderClientModule } from "./generate-rest-client.ts";
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
    column("size", { queryFilter: true }),
    column("createdAt", { queryOrder: { default: "asc" } }),
    column("amount", { where: ["gte", "lte"] }),
    column("version", { version: true }),
]);

const marker = table("marker", "Marker", [column("id", { primaryKey: true })]);

const tables = new Map([
    ["Marker", marker],
    ["Widget", widget],
]);

const model = buildRestModel(tables);

function widgetModule(): string {
    const widgetEntity = model.entities.find((entity) => entity.entity === "Widget");
    if (!widgetEntity) {
        throw new Error("fixture is missing the widget entity");
    }
    return renderClientModule(widgetEntity);
}

describe("renderClientModule", () => {
    it("builds a call rather than sending one, and binds no client", () => {
        const code = widgetModule();

        expect(code).toContain("export function queryWidget<S extends Selection<Widget>>(");
        expect(code).toContain("): Call<Selected<Widget, S>[]> {");
        expect(code).toContain('return call<Selected<Widget, S>[]>("GET", "/widget/query", opts);');
        expect(code).toContain('import { call, type Call } from "./client.ts";');
        expect(code).not.toContain("HttpClient");
    });

    it("names the verb and the path of each call, leaving the carrier to exec", () => {
        const code = widgetModule();

        expect(code).toContain('call<void>("POST", "/widget", rows)');
        expect(code).toContain('call<void>("PATCH", "/widget", rows)');
        expect(code).toContain('call<void>("DELETE", "/widget", rows)');
    });

    it("narrows the filters to the filterable fields", () => {
        expect(widgetModule()).toContain('filter?: Filters<Widget, "id" | "size">');
    });

    it("narrows the ordering to the orderable fields", () => {
        const code = widgetModule();

        expect(code).toContain('order?: Order<"createdAt">[]');
    });

    it("gives every read a limit and an offset", () => {
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const code = renderClientModule(markerEntity!);

        expect(code).toContain("limit?: number; offset?: number; select: S");
    });

    it("narrows the comparisons to the whitelisted operators", () => {
        const code = widgetModule();

        expect(code).toContain('where?: Where<Widget, { amount: "gte" | "lte" }>');
        expect(code).toContain('import type { Filters, Order, Selected, Selection, Where } from "spec/selection.ts";');
    });

    it("imports and re-exports the patch type from the validation package", () => {
        const code = widgetModule();

        expect(code).toContain('import type { WidgetInsert, WidgetPatch } from "validation/widget.ts";');
        expect(code).toContain("export type { WidgetInsert, WidgetPatch };");
        expect(code).toContain("rows: WidgetPatch[]");
        expect(code).not.toContain("export type WidgetPatch =");
    });

    it("does not decide the patch shape, so a table without a version needs no generator branch", () => {
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const code = renderClientModule(markerEntity!);

        expect(code).toContain('import type { MarkerInsert, MarkerPatch } from "validation/marker.ts";');
        expect(code).not.toContain("and the version");
    });

    it("deletes by the key", () => {
        const code = widgetModule();

        expect(code).toContain('rows: Pick<Widget, "id">[]');
        expect(code).toContain('call<void>("DELETE", "/widget", rows)');
    });

    it("deletes by every field of a composite key", () => {
        const composite = table("translation", "Translation", [
            column("languageCode", { primaryKey: true, queryFilter: true }),
            column("key", { primaryKey: true, queryFilter: true }),
            column("value"),
        ]);
        const entity = buildRestModel(new Map([["Translation", composite]])).entities[0];
        if (!entity) {
            throw new Error("fixture is missing the translation entity");
        }

        const code = renderClientModule(entity);

        expect(code).toContain('rows: Pick<Translation, "languageCode" | "key">[]');
        expect(code).toContain("keyed on `languageCode`, `key`");
    });

    it("types a create with the validation insert type, not the whole entity", () => {
        const code = widgetModule();

        expect(code).toContain('import type { WidgetInsert, WidgetPatch } from "validation/widget.ts";');
        expect(code).toContain(
            "export function createWidget(rows: WidgetInsert[]): Call<void> {",
        );
        expect(code).not.toContain("export type WidgetInsert =");
    });

    it("names the validation module after the entity", () => {
        const limited = table("limited", "Limited", [column("id", { primaryKey: true })]);
        const limitedModel = buildRestModel(new Map([["Limited", limited]]));
        const code = renderClientModule(limitedModel.entities[0]!);

        expect(code).toContain('import type { LimitedInsert, LimitedPatch } from "validation/limited.ts";');
    });

    it("emits no getter", () => {
        const code = widgetModule();
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const markerCode = renderClientModule(markerEntity!);

        expect(code).not.toContain("getWidget");
        expect(code).not.toContain("AtLeastOne");
        expect(markerCode).not.toContain("getMarker");
    });
});

describe("generateRestClient", () => {
    it("re-exports the call model, the transport, and every entity from the barrel", () => {
        const files = generateRestClient(model);

        expect(files.get("index.ts")).toContain('export * from "./client.ts";');
        expect(files.get("index.ts")).toContain('export * from "./http.ts";');
        expect(files.get("index.ts")).toContain('export * from "./widget.ts";');
        expect(files.has("widget.ts")).toBe(true);
    });

    it("imports nothing but spec, the shared validation types, and its own modules", () => {
        const files = generateRestClient(model);
        const specifiers: string[] = [];
        for (const content of files.values()) {
            for (const match of content.matchAll(/from "([^"]+)"/g)) {
                if (match[1]) {
                    specifiers.push(match[1]);
                }
            }
        }

        expect(specifiers.length).toBeGreaterThan(0);
        for (const specifier of specifiers) {
            expect(
                specifier.startsWith("spec/") ||
                    specifier.startsWith("validation/") ||
                    specifier.startsWith("./"),
            ).toBe(true);
        }
    });

    it("reaches the validation types without pulling zod into the client", () => {
        const files = generateRestClient(model);
        for (const content of files.values()) {
            expect(content).not.toContain('from "zod"');
            for (const line of content.split("\n")) {
                if (line.includes("validation/")) {
                    expect(line.startsWith("import type ") || line.startsWith("export type ")).toBe(true);
                }
            }
        }
    });

    it("exposes exactly the calls the server exposes", () => {
        const exposed = [...renderRoutesModule(model).matchAll(/method: "(\w+)",\s*\n\s*path: "([^"]+)"/g)].map(
            (match) => `${match[1]} ${match[2]}`,
        );
        const called = [...generateRestClient(model).values()].flatMap((content) =>
            [...content.matchAll(/call<.*?>\("(GET|POST|PATCH|DELETE)", "([^"]+)"/g)].map(
                (match) => `${match[1]} ${match[2]}`,
            ),
        );

        expect(exposed.length).toBeGreaterThan(0);
        expect([...called].sort()).toEqual([...exposed].sort());
    });
});
