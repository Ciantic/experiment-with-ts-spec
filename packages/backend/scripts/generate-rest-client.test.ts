/**
 * Unit tests for the client renderer, driven by self-contained fixtures.
 * See docs/testing.md.
 *
 * The last group is the invariant that makes the client worth generating: it may
 * import `spec` and its own transport, and nothing else. Both generators are then
 * driven from one model and the calls they expose are compared, so the two
 * cannot disagree about the wire.
 */
import { describe, expect, it } from "vitest";
import type { Column, Table } from "./postgres-model.ts";
import { buildRestModel } from "./rest-model.ts";
import { generateRestClient, renderClientModule } from "./generate-rest-client.ts";
import { renderRoutesModule } from "./generate-rest-api.ts";

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
    column("size", { queryFilter: true }),
    column("createdAt", { queryOrder: { default: "asc" } }),
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
    it("takes the transport where the server takes the executor", () => {
        const code = widgetModule();

        expect(code).toContain("export function queryWidget<S extends Selection<Widget>>(");
        expect(code).toContain("    http: HttpClient,");
        expect(code).toContain('return http.query<Selected<Widget, S>[]>("GET", "/widget/query", opts);');
    });

    it("sends a read through the query parameter and a write through the body", () => {
        const code = widgetModule();

        expect(code).toContain('http.send<void>("POST", "/widget", rows)');
        expect(code).toContain('http.send<void>("PATCH", "/widget", rows)');
        expect(code).toContain('http.query<void>("DELETE", "/widget", rows)');
    });

    it("narrows the filters to the filterable fields", () => {
        expect(widgetModule()).toContain('filter?: Filters<Widget, "id" | "size">');
    });

    it("narrows the ordering to the orderable fields", () => {
        const code = widgetModule();

        expect(code).toContain('order?: Order<"createdAt">[]');
        expect(code).toContain('import type { Filters, Order, Selected, Selection } from "spec/selection.ts";');
    });

    it("gives every read a limit and an offset", () => {
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const code = renderClientModule(markerEntity!);

        expect(code).toContain("limit?: number; offset?: number; select: S");
    });

    it("declares the patch locally, since it cannot import the repository's", () => {
        const code = widgetModule();

        expect(code).toContain(
            'export type WidgetPatch = Partial<Widget> & Required<Pick<Widget, "id" | "version">>;',
        );
        expect(code).toContain("rows: WidgetPatch[]");
    });

    it("requires only the key in a patch when there is no version", () => {
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const code = renderClientModule(markerEntity!);

        expect(code).toContain(
            'export type MarkerPatch = Partial<Marker> & Required<Pick<Marker, "id">>;',
        );
        expect(code).not.toContain("and the version");
    });

    it("deletes by the key", () => {
        const code = widgetModule();

        expect(code).toContain('rows: Pick<Widget, "id">[]');
        expect(code).toContain('http.query<void>("DELETE", "/widget", rows)');
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
    it("re-exports the transport and every entity from the barrel", () => {
        const files = generateRestClient(model);

        expect(files.get("index.ts")).toContain('export * from "./http.ts";');
        expect(files.get("index.ts")).toContain('export * from "./widget.ts";');
        expect(files.has("widget.ts")).toBe(true);
    });

    it("imports nothing but spec and its own transport", () => {
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
            expect(specifier.startsWith("spec/") || specifier.startsWith("./")).toBe(true);
        }
    });

    it("exposes exactly the calls the server exposes", () => {
        const exposed = [...renderRoutesModule(model).matchAll(/method: "(\w+)",\s*\n\s*path: "([^"]+)"/g)].map(
            (match) => `${match[1]} ${match[2]}`,
        );
        const called = [...generateRestClient(model).values()].flatMap((content) =>
            [...content.matchAll(/http\.(?:query|send)<.*?>\("(GET|POST|PATCH|DELETE)", "([^"]+)"/g)].map(
                (match) => `${match[1]} ${match[2]}`,
            ),
        );

        expect(exposed.length).toBeGreaterThan(0);
        expect([...called].sort()).toEqual([...exposed].sort());
    });
});
