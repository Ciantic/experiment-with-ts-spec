/** Unit tests for the REST model, driven by self-contained fixtures. See docs/testing.md. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { SPEC_SRC_ROOT } from "spec/scripts/spec-model.ts";
import { buildRestModel, type RestModel } from "./rest-model.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const DOMAIN_GLOB = join(SPEC_SRC_ROOT, "domain/**/*.ts");

/** A filterable entity: a key, a size filter, an ordering key, a comparable, and a version. */
const WIDGET = `
/**
 * @pgTable widget
 */
export interface Widget {
    /** @primaryKey */
    id: string;

    /** @queryFilter */
    size: string;

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
 */
export interface Translation {
    /** @primaryKey */
    languageCode: string;

    /** @primaryKey */
    key: string;

    value?: string;
}
`.trim();

/** An entity the spec never keys; a write to it has no row to address. */
const KEYLESS = `
/**
 * @pgTable keyless
 */
export interface Keyless {
    name: string;
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

const model = build({ Widget: WIDGET, Marker: MARKER });

describe("buildRestModel", () => {
    it("keys every entity by its interface name and orders them", () => {
        expect(model.entities.map((entity) => entity.entity)).toEqual(["Marker", "Widget"]);
    });

    it("takes the collection path from the table name", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.path).toBe("/widget");
        expect(widget?.module).toBe("widget");
        expect(widget?.importSpecifier).toBe("spec/domain/Widget.ts");
    });

    it("exposes a read, a write, and a delete for every entity", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.operations.map((operation) => operation.kind)).toEqual([
            "query",
            "create",
            "update",
            "delete",
        ]);
    });

    it("reads with GET and writes with the method each call means", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

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
        const widget = model.entities.find((entity) => entity.entity === "Widget");
        const byKind = new Map(widget?.operations.map((operation) => [operation.kind, operation]));

        expect(byKind.get("query")?.source).toBe("query");
        expect(byKind.get("delete")?.source).toBe("query");
        expect(byKind.get("create")?.source).toBe("body");
        expect(byKind.get("update")?.source).toBe("body");
    });

    it("records the filter fields, the keys, and the version fields", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.filters).toEqual(["id", "size"]);
        expect(widget?.keys).toEqual(["id"]);
        expect(widget?.versionFields).toEqual(["version"]);
    });

    it("records every field of a composite key in declaration order", () => {
        const entity = build({ Translation: TRANSLATION }).entities[0];

        expect(entity?.keys).toEqual(["languageCode", "key"]);
    });

    it("reports an entity with no key rather than emitting a keyless write", () => {
        const diagnostics = build({ Keyless: KEYLESS }).diagnostics;

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "`Keyless`: no `@primaryKey` field",
        ]);
    });

    it("records the orderable fields", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");
        const marker = model.entities.find((entity) => entity.entity === "Marker");

        expect(widget?.orderFields).toEqual(["createdAt"]);
        expect(marker?.orderFields).toEqual([]);
    });

    it("records the comparable fields with their operators", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");
        const marker = model.entities.find((entity) => entity.entity === "Marker");

        expect(widget?.whereFields).toEqual([{ name: "amount", operators: ["gte", "lte"] }]);
        expect(marker?.whereFields).toEqual([]);
    });
});
