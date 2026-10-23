/** Unit tests for the server route renderer, driven by self-contained fixtures. See docs/testing.md. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec } from "spec/scripts/spec-model.ts";
import { buildRestModel, type RestEntity, type RestModel } from "../../sdk/scripts/rest-model.ts";
import {
    renderEntityRoutes,
    renderOperationRoutes,
    renderRoutes,
    renderRoutesIndex,
} from "./generate-rest-api.ts";
// The drift check drives both generators from one model, so it lives here with the server's renderer.
import { generateRestClient } from "../../sdk/scripts/generate-rest-client.ts";

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

    it("names the operation, the path, the method, and the schema of each call", () => {
        const code = render();

        expect(code).toContain('id: "queryWidget"');
        expect(code).toContain('id: "createWidget"');
        expect(code).toContain('id: "upsertWidget"');
        expect(code).toContain('id: "updateWidget"');
        expect(code).toContain('id: "deleteWidget"');
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

        expect(code).toContain("handler: (ctx, body) => queryWidget(ctx.db, body as never)");
        expect(code).toContain("handler: (ctx, body) => createWidget(ctx.db, body as never)");
        expect(code).toContain("handler: (ctx, body) => upsertWidget(ctx.db, body as never)");
        expect(code).toContain("handler: (ctx, body) => updateWidget(ctx.db, body as never)");
        expect(code).toContain("handler: (ctx, body) => deleteWidget(ctx.db, body as never)");
    });

    it("imports every generated piece from its barrel", () => {
        const code = render();

        expect(code).toContain('from "../../db/queries/index.ts"');
        expect(code).toContain('from "../../db/repositories/index.ts"');
        expect(code).toContain('from "sdk/schemas.ts"');
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

        expect(code).toContain("handler: (ctx, body) => createAuditLog(ctx.db, body as never)");
        expect(code).toContain("handler: (ctx, body) => queryAuditLog(ctx.db, body as never)");
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

        expect(code).toContain("handler: (ctx, body) => createInternal(ctx.db, body as never)");
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

        expect([...files.keys()]).toEqual(["markerRoutes.ts", "widgetRoutes.ts", "operationRoutes.ts", "index.ts"]);
        expect(files.get("widgetRoutes.ts")).toBe(renderEntityRoutes(widgetEntity()));
    });
});

describe("the pair", () => {
    it("exposes exactly the calls the server exposes", () => {
        const model = build({ Widget: WIDGET, Marker: MARKER, WidgetOperations: OPERATIONS });
        // Every route module, barrel included; the barrel names no id, so it adds nothing.
        const exposed = [...renderRoutes(model).values()].flatMap((content) =>
            [...content.matchAll(/id: "(\w+)",/g)].map((match) => match[1]),
        );
        const called = [...generateRestClient(model).values()].flatMap((content) =>
            [...content.matchAll(/call<.*?>\("(\w+)",/g)].map((match) => match[1]),
        );

        expect(exposed).toContain("sendWidget");
        expect(exposed).toContain("resetWidgets");
        expect([...called].sort()).toEqual([...exposed].sort());
    });
});

/** A contract exposing a REST operation with an input and one without. */
const OPERATIONS = `
import type { Widget } from "./Widget.ts";

export interface WidgetOperations<T> {
    /**
     * Send the widget.
     *
     * @operation
     * @restOperation POST /widget/send
     */
    sendWidget(ctx: T, opts: { widget: Widget }): Promise<Widget>;

    /**
     * Reset the widgets.
     *
     * @operation
     * @restOperation POST /widget/reset
     */
    resetWidgets(ctx: T): Promise<void>;
}
`.trim();

describe("renderOperationRoutes", () => {
    const withOperations = build({ Widget: WIDGET, Marker: MARKER, WidgetOperations: OPERATIONS });

    it("renders one route per @restOperation, keyed by its id", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('export const operationRoutes: Route[] = [');
        expect(code).toContain('id: "sendWidget"');
        expect(code).toContain('method: "POST"');
        expect(code).toContain('path: "/widget/send"');
        expect(code).toContain("input: sendWidgetSchema");
    });

    it("hands the route's context straight to the operation, so the compiler checks it", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain("handler: (ctx, body) => sendWidget(ctx, body as SendWidgetInput)");
        expect(code).toContain('import { sendWidgetSchema, type SendWidgetInput } from "sdk/schemas.ts";');
    });

    it("imports each operation module by file and validates a call with no input against undefined", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('import { sendWidget } from "../../operations/sendWidget.ts";');
        expect(code).toContain('import { z } from "zod";');
        expect(code).toContain("input: z.undefined()");
        expect(code).toContain("handler: (ctx) => resetWidgets(ctx)");
    });

    it("joins the barrier every entity's routes are spread into", () => {
        const code = renderRoutesIndex(withOperations);

        expect(code).toContain('import { operationRoutes } from "./operationRoutes.ts";');
        expect(code).toContain("    ...operationRoutes,");
    });

    it("writes the operation module even when the spec declares none", () => {
        const files = renderRoutes(build({ Widget: WIDGET }));

        expect(files.get("operationRoutes.ts")).toContain("export const operationRoutes: Route[] = [];");
    });
});
