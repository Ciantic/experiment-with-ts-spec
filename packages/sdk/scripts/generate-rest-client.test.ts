/**
 * Unit tests for the client renderer, driven by self-contained fixtures.
 * See docs/testing.md.
 *
 * The last group is the invariant that makes the client worth generating: it may
 * import `spec`, the shared schema types, and its own modules, and nothing
 * else. Both generators are then driven from one model and the calls they expose
 * are compared, so the two cannot disagree about the wire.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec } from "spec/scripts/spec-model.ts";
import { buildRestModel, type RestModel } from "./rest-model.ts";
import { generateRestClient, renderClientModule } from "./generate-rest-client.ts";
import { renderRoutes } from "./generate-rest-api.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** A filterable entity: a key, an optional filter, a required filter, an ordering key, a comparable, and a version. */
const WIDGET = `
/**
 * @pgTable widget
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Widget {
    /** @primaryKey */
    id: string;

    /** @queryFilter */
    size: string;

    /** @queryFilter required */
    tenantId: string;

    /** @queryOrderBy default asc */
    createdAt: Date;

    /** @queryWhere gte lte */
    amount: number;

    /** @version */
    version: bigint;
}
`.trim();

/** A bare entity: a key and nothing else. */
const MARKER = `
/**
 * @pgTable marker
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Marker {
    /** @primaryKey */
    id: string;
}
`.trim();

/** An entity keyed by two fields, so a write addresses it by both. */
const TRANSLATION = `
/**
 * @pgTable translation
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Translation {
    /** @primaryKey */
    languageCode: string;

    /** @primaryKey */
    key: string;

    value?: string;
}
`.trim();

/** An entity whose module name differs from its schema file, which is lower-cased. */
const LIMITED = `
/**
 * @pgTable limited
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Limited {
    /** @primaryKey */
    id: string;
}
`.trim();

/** Build a model from in-memory domain files, so no test reads the real spec. */
function build(domain: Record<string, string>): RestModel {
    const spec = Object.entries(domain).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", `${name}.ts`),
        sourceFileText,
    }));
    return buildRestModel(parseInMemorySpec(spec, { sourceGlob: SPEC_GLOB }));
}

const model = build({ Widget: WIDGET, Marker: MARKER });

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
        expect(code).toContain('return call<Selected<Widget, S>[]>("queryWidget", "GET", "/widget/query", opts);');
        expect(code).toContain('import type { Widget } from "spec/fixtures/Widget.ts";');
        expect(code).toContain('import { call, type Call } from "../client.ts";');
        expect(code).not.toContain("HttpClient");
    });

    it("names the operation and the verb and path of each call, leaving the carrier to exec", () => {
        const code = widgetModule();

        expect(code).toContain('call<WidgetPrimaryKey[]>("createWidget", "POST", "/widget", rows)');
        expect(code).toContain('call<WidgetPrimaryKey[]>("upsertWidget", "PUT", "/widget", rows)');
        expect(code).toContain('call<void>("updateWidget", "PATCH", "/widget", rows)');
        expect(code).toContain('call<void>("deleteWidget", "DELETE", "/widget", rows)');
    });

    it("narrows the filters to the filterable fields, requiring the required ones", () => {
        expect(widgetModule()).toContain('filter: Filters<Widget, "id" | "size" | "tenantId", "tenantId">');
    });

    it("leaves the filter optional when the entity requires none", () => {
        const marker = model.entities.find((entity) => entity.entity === "Marker");

        expect(renderClientModule(marker!)).toContain('filter?: Filters<Marker, "id">');
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
        expect(code).toContain('import type { Filters, Order, Selected, Selection, Where } from "../selection.ts";');
    });

    it("imports and re-exports the write types and the key from the schema modules", () => {
        const code = widgetModule();

        expect(code).toContain('import type { WidgetInsert } from "../repositories/widgetInsertSchema.ts";' +
            '\n' +
            'import type { WidgetPatch } from "../repositories/widgetPatchSchema.ts";' +
            '\n' +
            'import type { WidgetPrimaryKey } from "../repositories/widgetPrimaryKeySchema.ts";' +
            '\n' +
            'import type { WidgetUpsert } from "../repositories/widgetUpsertSchema.ts";');
        expect(code).toContain("export type { WidgetInsert, WidgetPatch, WidgetPrimaryKey, WidgetUpsert };");
        expect(code).toContain("rows: WidgetPatch[]");
        expect(code).not.toContain("export type WidgetPatch =");
    });

    it("upserts with the schema upsert type, which carries the version a create omits", () => {
        const code = widgetModule();

        expect(code).toContain("export function upsertWidget(rows: WidgetUpsert[]): Call<WidgetPrimaryKey[]> {");
        expect(code).toContain("replaces the row at the version it claims");
    });

    it("does not decide the patch shape, so a table without a version needs no generator branch", () => {
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const code = renderClientModule(markerEntity!);

        expect(code).toContain('import type { MarkerInsert } from "../repositories/markerInsertSchema.ts";' +
            '\n' +
            'import type { MarkerPatch } from "../repositories/markerPatchSchema.ts";' +
            '\n' +
            'import type { MarkerPrimaryKey } from "../repositories/markerPrimaryKeySchema.ts";' +
            '\n' +
            'import type { MarkerUpsert } from "../repositories/markerUpsertSchema.ts";');
        expect(code).not.toContain("and the version");
    });

    it("deletes by the key", () => {
        const code = widgetModule();

        expect(code).toContain("rows: WidgetPrimaryKey[]");
        expect(code).toContain('call<void>("deleteWidget", "DELETE", "/widget", rows)');
    });

    it("deletes by every field of a composite key", () => {
        const entity = build({ Translation: TRANSLATION }).entities[0];
        if (!entity) {
            throw new Error("fixture is missing the translation entity");
        }

        const code = renderClientModule(entity);

        // The key projection is the one the schema declares, not a second one written here.
        expect(code).toContain("rows: TranslationPrimaryKey[]");
        expect(code).toContain('import type { TranslationPrimaryKey } from "../repositories/translationPrimaryKeySchema.ts";');
        expect(code).not.toContain("Pick<Translation,");
        expect(code).toContain("keyed on `languageCode`, `key`");
    });

    it("types a create with the schema insert type, not the whole entity", () => {
        const code = widgetModule();

        expect(code).toContain('import type { WidgetInsert } from "../repositories/widgetInsertSchema.ts";' +
            '\n' +
            'import type { WidgetPatch } from "../repositories/widgetPatchSchema.ts";');
        expect(code).toContain(
            "export function createWidget(rows: WidgetInsert[]): Call<WidgetPrimaryKey[]> {",
        );
        expect(code).not.toContain("export type WidgetInsert =");
    });

    it("names the schema module after the entity", () => {
        const code = renderClientModule(build({ Limited: LIMITED }).entities[0]!);

        expect(code).toContain('import type { LimitedInsert } from "../repositories/limitedInsertSchema.ts";' +
            '\n' +
            'import type { LimitedPatch } from "../repositories/limitedPatchSchema.ts";' +
            '\n' +
            'import type { LimitedPrimaryKey } from "../repositories/limitedPrimaryKeySchema.ts";' +
            '\n' +
            'import type { LimitedUpsert } from "../repositories/limitedUpsertSchema.ts";');
    });

    it("emits no getter", () => {
        const code = widgetModule();
        const markerEntity = model.entities.find((entity) => entity.entity === "Marker");
        const markerCode = renderClientModule(markerEntity!);

        expect(code).not.toContain("getWidget");
        expect(code).not.toContain("AtLeastOne");
        expect(markerCode).not.toContain("getMarker");
    });

    it("builds only the calls @restRepository exposes, and keeps the read", () => {
        const audit = `
/**
 * @pgTable audit_log
 * @repository create
 * @restRepository create
 * @queries query
 * @restQueries query
 * @entity
 */
export interface AuditLog {
    /** @primaryKey */
    id: string;
}
`.trim();
        const entity = build({ AuditLog: audit }).entities[0]!;
        const code = renderClientModule(entity);

        expect(code).toContain("export function queryAuditLog");
        expect(code).toContain("export function createAuditLog");
        expect(code).not.toContain("export function upsertAuditLog");
        expect(code).not.toContain("export function updateAuditLog");
        expect(code).not.toContain("export function deleteAuditLog");
        expect(code).not.toContain("AuditLogPatch");
        expect(code).not.toContain("AuditLogUpsert");
    });

    it("builds no read, and imports nothing for one, when the entity carries no @restQueries", () => {
        const internal = `
/**
 * @pgTable internal
 * @repository create
 * @restRepository create
 * @queries query
 * @entity
 */
export interface Internal {
    /** @primaryKey */
    id: string;
}
`.trim();
        const entity = build({ Internal: internal }).entities[0]!;
        const code = renderClientModule(entity);

        expect(code).toContain("export function createInternal");
        expect(code).not.toContain("export function queryInternal");
        expect(code).not.toContain("Selection");
        expect(code).not.toContain("spec/fixtures/Internal.ts");
    });
});

describe("generateRestClient", () => {
    it("re-exports every entity from the barrel, and nothing outside the directory", () => {
        const files = generateRestClient(model);

        expect(files.get("index.ts")).toContain('export * from "./widget.ts";');
        expect(files.get("index.ts")).not.toContain('"../');
        expect(files.has("widget.ts")).toBe(true);
    });

    it("imports nothing but spec, the shared schema types, and its own modules", () => {
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
                    specifier.startsWith("./") ||
                    specifier.startsWith("../"),
            ).toBe(true);
        }
    });

    it("reaches the schema types without pulling zod into the client", () => {
        const files = generateRestClient(model);
        for (const content of files.values()) {
            expect(content).not.toContain('from "zod"');
            for (const line of content.split("\n")) {
                if (line.includes("../repositories/") || line.includes("../selection.ts")) {
                    expect(line.startsWith("import type ") || line.startsWith("export type ")).toBe(true);
                }
            }
        }
    });

    it("exposes exactly the calls the server exposes", () => {
        // Every route module, barrel included; the barrel names no id, so it adds nothing.
        const exposed = [...renderRoutes(model).values()].flatMap((content) =>
            [...content.matchAll(/id: "(\w+)",/g)].map((match) => match[1]),
        );
        const called = [...generateRestClient(model).values()].flatMap((content) =>
            [...content.matchAll(/call<.*?>\("(\w+)",/g)].map((match) => match[1]),
        );

        expect(exposed.length).toBeGreaterThan(0);
        expect([...called].sort()).toEqual([...exposed].sort());
    });
});
