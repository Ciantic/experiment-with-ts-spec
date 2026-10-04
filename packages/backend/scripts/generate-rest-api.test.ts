/** Unit tests for the server route renderer, driven by self-contained fixtures. See docs/testing.md. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { SPEC_SRC_ROOT } from "spec/scripts/spec-model.ts";
import { buildRestModel, type RestModel } from "./rest-model.ts";
import { renderRoutesModule } from "./generate-rest-api.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const DOMAIN_GLOB = join(SPEC_SRC_ROOT, "domain/**/*.ts");

/** A versioned entity, so the routes cover a patch as well as a plain write. */
const WIDGET = `
/**
 * @table widget
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
 * @table marker
 */
export interface Marker {
    /** @primaryKey */
    id: string;
}
`.trim();

/** Build a model from in-memory domain files, so no test reads the real spec. */
function build(domain: Record<string, string>): RestModel {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const [name, text] of Object.entries(domain)) {
        project.createSourceFile(join(SPEC_SRC_ROOT, "domain", `${name}.ts`), text);
    }
    return buildRestModel(project, { specGlob: DOMAIN_GLOB, aliasGlob: DOMAIN_GLOB });
}

function render(): string {
    return renderRoutesModule(build({ Widget: WIDGET, Marker: MARKER }));
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
