/** Unit tests for the server route renderer, driven by self-contained fixtures. See docs/testing.md. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec } from "spec/scripts/spec-model.ts";
import { buildRestModel, type RestEntity, type RestModel } from "./rest-model.ts";
import { renderEntityRoutes, renderRoutes, renderRoutesIndex } from "./generate-rest-api.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** A versioned entity, so the routes cover a patch as well as a plain write. */
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

/** Build a model from in-memory domain files, so no test reads the real spec. */
function build(domain: Record<string, string>): RestModel {
    const spec = Object.entries(domain).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", `${name}.ts`),
        sourceFileText,
    }));
    return buildRestModel(parseInMemorySpec(spec, { sourceGlob: SPEC_GLOB }));
}

function widgetEntity(): RestEntity {
    const entity = build({ Widget: WIDGET, Marker: MARKER }).entities.find((it) => it.entity === "Widget");
    if (!entity) {
        throw new Error("fixture is missing the widget entity");
    }
    return entity;
}

function render(): string {
    return renderEntityRoutes(widgetEntity());
}

describe("renderEntityRoutes", () => {
    it("emits a typed route table for one collection", () => {
        const code = render();

        expect(code).toContain('import type { Route } from "../router.ts";');
        expect(code).toContain("export const widgetRoutes: Route[] = [");
    });

    it("names the path, the method, and the schema of each call", () => {
        const code = render();

        expect(code).toContain('path: "/widget/query"');
        expect(code).toContain("input: queryWidgetSchema");
        expect(code).toContain("input: z.array(widgetInsertSchema)");
        expect(code).toContain("input: z.array(widgetUpsertSchema)");
        expect(code).toContain("input: z.array(widgetPatchSchema)");
    });

    it("validates a write as a batch, since the repository takes rows", () => {
        const code = render();

        expect(code).toContain("input: z.array(widgetInsertSchema)");
        expect(code).toContain("input: z.array(widgetUpsertSchema)");
        expect(code).toContain("input: z.array(widgetPatchSchema)");
        expect(code).toContain("input: z.array(widgetPrimaryKeySchema)");
    });

    it("reads with GET and says the argument travels in the query string", () => {
        const code = render();

        expect(code).toMatch(/method: "GET",\s*\n\s*path: "\/widget\/query",\s*\n\s*source: "query",/);
    });

    it("posts an entity, puts a replacement, and patches a patch from the body", () => {
        const code = render();

        expect(code).toMatch(/method: "POST",\s*\n\s*path: "\/widget",\s*\n\s*source: "body",/);
        expect(code).toMatch(/method: "PUT",\s*\n\s*path: "\/widget",\s*\n\s*source: "body",/);
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
        expect(code).toContain("handler: (db, body) => upsertWidget(db, body as never)");
        expect(code).toContain("handler: (db, body) => updateWidget(db, body as never)");
        expect(code).toContain("handler: (db, body) => deleteWidget(db, body as never)");
    });

    it("imports every generated piece from its barrel", () => {
        const code = render();

        expect(code).toContain('from "../../db/queries/index.ts"');
        expect(code).toContain('from "../../db/repositories/index.ts"');
        expect(code).toContain('from "validation/index.ts"');
    });

    it("emits no get route", () => {
        const code = render();

        expect(code).not.toContain("getWidgetSchema");
        expect(code).not.toContain("/widget/get");
    });

    it("imports only what this collection's calls need", () => {
        const code = render();

        expect(code).toContain("import { queryWidget }");
        expect(code).not.toContain("queryMarker");
        expect(code).not.toContain("createMarker");
    });

    it("names every import once, sorted", () => {
        const queries = render().match(/import \{ ([^}]+) \} from "\.\.\/\.\.\/db\/queries\/index\.ts"/)?.[1] ?? "";
        const names = queries.split(", ");

        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(new Set(names).size).toBe(names.length);
    });

    it("emits only the writes @restRepository exposes, keeping the read", () => {
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
        const entity = build({ AuditLog: audit }).entities[0];
        if (!entity) {
            throw new Error("fixture is missing the audit entity");
        }
        const code = renderEntityRoutes(entity);

        expect(code).toContain("handler: (db, body) => createAuditLog(db, body as never)");
        expect(code).toContain("handler: (db, body) => queryAuditLog(db, body as never)");
        expect(code).not.toContain("upsertAuditLog");
        expect(code).not.toContain("updateAuditLog");
        expect(code).not.toContain("deleteAuditLog");
        expect(code).not.toContain("auditLogPatchSchema");
    });

    it("emits no read route when the entity carries no @restQueries", () => {
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
        const entity = build({ Internal: internal }).entities[0];
        if (!entity) {
            throw new Error("fixture is missing the internal entity");
        }
        const code = renderEntityRoutes(entity);

        expect(code).toContain("handler: (db, body) => createInternal(db, body as never)");
        expect(code).not.toContain("queryInternal");
        expect(code).not.toContain("/internal/query");
    });
});

describe("renderRoutesIndex", () => {
    it("concatenates every entity's routes into the table the router takes", () => {
        const code = renderRoutesIndex(build({ Widget: WIDGET, Marker: MARKER }));

        expect(code).toContain("export const routes: Route[] = [");
        expect(code).toContain("    ...markerRoutes,");
        expect(code).toContain("    ...widgetRoutes,");
    });

    it("imports each entity's routes from its own module", () => {
        const code = renderRoutesIndex(build({ Widget: WIDGET, Marker: MARKER }));

        expect(code).toContain('import { widgetRoutes } from "./widgetRoutes.ts";');
        expect(code).toContain('import { markerRoutes } from "./markerRoutes.ts";');
    });

    it("gives every entity and the barrel a module", () => {
        const files = renderRoutes(build({ Widget: WIDGET, Marker: MARKER }));

        expect([...files.keys()]).toEqual(["markerRoutes.ts", "widgetRoutes.ts", "index.ts"]);
        expect(files.get("widgetRoutes.ts")).toBe(renderEntityRoutes(widgetEntity()));
    });
});
