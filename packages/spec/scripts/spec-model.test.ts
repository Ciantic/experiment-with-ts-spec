/** Unit tests for parseSpec, driven by self-contained fixtures. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { SPEC_SRC_ROOT, parseSpec, readTags } from "./spec-model.ts";

const GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** Parse an in-memory spec, so no test reads the real domain. */
function parse(files: Record<string, string>) {
    const project = new Project({ useInMemoryFileSystem: true });
    for (const [name, text] of Object.entries(files)) {
        project.createSourceFile(join(SPEC_SRC_ROOT, "fixtures", name), text);
    }
    return parseSpec(project, { entityGlob: GLOB, aliasGlob: GLOB });
}

describe("parseSpec interfaces", () => {
    it("snake-cases the table name by default", () => {
        const { interfaces } = parse({ "LineItem.ts": "export interface LineItem { id: string; }" });

        expect(interfaces.get("LineItem")?.tableName).toBe("line_item");
    });

    it("lets @table override the table name", () => {
        const { interfaces } = parse({
            "Person.ts": "/** @table people */\nexport interface Person { id: string; }",
        });

        expect(interfaces.get("Person")?.tableName).toBe("people");
    });

    it("maps a source file back to its package import specifier", () => {
        const { interfaces } = parse({ "Thing.ts": "export interface Thing { id: string; }" });

        expect(interfaces.get("Thing")?.importSpecifier).toBe("spec/fixtures/Thing.ts");
    });

    it("collects the interface's properties with their option flags", () => {
        const { interfaces } = parse({
            "Thing.ts": "export interface Thing { id: string; note?: string; }",
        });

        const properties = interfaces.get("Thing")?.properties ?? [];

        expect(properties.map((property) => [property.name, property.optional])).toEqual([
            ["id", false],
            ["note", true],
        ]);
    });
});

describe("parseSpec tags", () => {
    const thing = (doc: string, field: string) =>
        `export interface Thing {\n${doc}\n    ${field}\n}`;

    it("decodes field tags once", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @fieldName Label\n     * @widget text\n     * @relation\n     */",
                "owner?: Owner;",
            ),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.fieldName).toBe("Label");
        expect(tags?.widget).toBe("text");
        expect(tags?.relation).toBe(true);
    });

    it("decodes a bare marker as a boolean", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @generated\n     * @unique\n     */", "code: string;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.generated).toBe(true);
        expect(tags?.unique).toBe(true);
        expect(tags?.version).toBe(false);
    });

    it("parses computed parameters", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @computed storage=stored formula=rowNet\n     */", "net: Decimal;"),
        });

        const computed = interfaces.get("Thing")?.properties[0]?.tags.computed;

        expect(computed?.storage).toBe("stored");
        expect(computed?.formula).toBe("rowNet");
        expect([...computed!.parameters.keys()]).toEqual(["storage", "formula"]);
    });

    it("keeps duplicate tags in the raw map", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @unique\n     * @unique\n     */", "code: string;"),
        });

        const byName = interfaces.get("Thing")?.properties[0]?.tags.byName;

        expect(byName?.get("unique")).toHaveLength(2);
    });

    it("decodes @queryfilter as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryfilter\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryfilter).toBe(true);
    });

    it("makes the id field a filter without the tag", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName ID\n     */", "id: ThingId;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryfilter).toBe(true);
    });

    it("does not make another field a filter by default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName Label\n     */", "label: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryfilter).toBe(false);
    });

    it("decodes a bare @queryorderby", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryorderby\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryOrderBy).toEqual({});
    });

    it("decodes @queryorderby default asc", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryorderby default asc\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryOrderBy).toEqual({ default: "asc" });
    });

    it("leaves an @queryorderby value the linter rejects as no default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryorderby sideways\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryOrderBy).toEqual({});
    });
});

describe("parseSpec formulas", () => {
    it("collects names from @formula aliases only", () => {
        const { formulaNames } = parse({
            "InvoiceRow.ts": [
                "/**\n * @formula\n */",
                'export type RowFormula = "rowNet" | "rowTax";',
                'export type NotAFormula = "other";',
            ].join("\n"),
        });

        expect([...formulaNames].sort()).toEqual(["rowNet", "rowTax"]);
    });
});

describe("readTags", () => {
    it("distinguishes a missing tag from an empty one", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            "/Thing.ts",
            "export interface Thing {\n    /**\n     * @fieldName\n     */\n    label: string;\n}",
        );

        const tags = readTags(sourceFile.getInterfaces()[0]!.getProperties()[0]!);

        expect(tags.byName.has("fieldName")).toBe(true);
        expect(tags.fieldName).toBeUndefined();
    });
});
