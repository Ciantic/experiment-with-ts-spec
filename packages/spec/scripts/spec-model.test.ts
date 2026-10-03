/** Unit tests for parseSpec, driven by self-contained fixtures. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { SPEC_SRC_ROOT, omittedFromPatch, parseSpec, primaryKeyProperties, readTags } from "./spec-model.ts";

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

    it("decodes @computed as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @computed\n     * @pgtrigger NEW.\"net\" := NEW.\"q\" * NEW.\"p\"\n     */", "net: Decimal;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.computed).toBe(true);
        expect(tags?.pgtrigger).toBe('NEW."net" := NEW."q" * NEW."p"');
        expect(tags?.pgvirtual).toBeUndefined();
        expect(tags?.pgrollup).toBeUndefined();
    });

    it("decodes the clock tags and the virtual expression", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @computed\n     * @pgvirtual \"net\" + \"tax\"\n     */", "total?: Decimal;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.pgvirtual).toBe('"net" + "tax"');
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

    it("decodes @primaryKey as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @primaryKey\n     */", "id: ThingId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.primaryKey).toBe(true);
        expect(tags?.foreignKey).toBeUndefined();
    });

    it("decodes @foreignKey with the interface it references", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @foreignKey Owner\n     */", "ownerId?: OwnerId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.foreignKey).toBe("Owner");
        expect(tags?.primaryKey).toBe(false);
    });

    it("lists a composite key's fields in declaration order", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @primaryKey\n     */",
                "code: string;\n    /**\n     * @primaryKey\n     */\n    languageCode: string;",
            ),
        });
        const spec = interfaces.get("Thing");

        expect(primaryKeyProperties(spec!).map((property) => property.name)).toEqual(["code", "languageCode"]);
    });

    it("makes the @primaryKey field a filter without the tag", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName ID\n     * @primaryKey\n     */", "id: ThingId;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryfilter).toBe(true);
    });

    it("does not treat a field named id as the primary key", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName ID\n     */", "id: ThingId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.primaryKey).toBe(false);
        expect(tags?.queryfilter).toBe(false);
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

    it("decodes @where operators in declaration order", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @where gte lte\n     */", "at: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.where).toEqual(["gte", "lte"]);
    });

    it("decodes a bare @where as an empty operator list", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @where\n     */", "at: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.where).toEqual([]);
    });

    it("leaves where undefined when the tag is absent", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName At\n     */", "at: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.where).toBeUndefined();
    });
});

describe("parseSpec clock tags", () => {
    it("decodes @createdAt and @updatedAt as bare markers", () => {
        const { interfaces } = parse({
            "Thing.ts": [
                "export interface Thing {",
                "    /**\n     * @createdAt\n     */",
                "    madeAt?: Date;",
                "    /**\n     * @updatedAt\n     */",
                "    changedAt?: Date;",
                "}",
            ].join("\n"),
        });

        const properties = interfaces.get("Thing")?.properties ?? [];

        expect(properties[0]?.tags.createdAt).toBe(true);
        expect(properties[0]?.tags.updatedAt).toBe(false);
        expect(properties[1]?.tags.updatedAt).toBe(true);
        expect(properties[1]?.tags.createdAt).toBe(false);
    });
});

describe("patch field rules", () => {
    /** The tag block for one field, and the field itself. */
    const field = (doc: string, declaration: string) => `export interface Thing {\n${doc}\n    ${declaration}\n}`;
    const omitted = (doc: string, declaration: string) => {
        const spec = parse({ "Thing.ts": field(doc, declaration) }).interfaces.get("Thing")!;
        return omittedFromPatch(spec).map((property) => property.name);
    };

    it("keeps a plain field patchable", () => {
        expect(omitted("    /**\n     * @fieldName Label\n     */", "label?: string;")).toEqual([]);
    });

    it("refuses a field a database default owns", () => {
        expect(omitted("    /**\n     * @default now()\n     */", "createdAt?: Date;")).toEqual(["createdAt"]);
    });

    it("keeps the version patchable, because a patch carries it to lock the row", () => {
        expect(omitted("    /**\n     * @version\n     * @default 0\n     */", "version?: number;")).toEqual([]);
    });

    it("refuses a nullable computation the trigger derives", () => {
        expect(omitted('    /**\n     * @computed\n     * @pgtrigger NEW."net" := NEW."q" * NEW."p"\n     */', "net?: Money;")).toEqual(["net"]);
    });

    it("keeps a required trigger computation, which the caller alone can supply", () => {
        expect(omitted('    /**\n     * @computed\n     * @pgtrigger NEW."net" := NEW."q" * NEW."p"\n     */', "net: Money;")).toEqual([]);
    });

    it("refuses a virtual generated column even when the field is required", () => {
        expect(omitted('    /**\n     * @computed\n     * @pgvirtual "net" + "tax"\n     */', "total: Money;")).toEqual(["total"]);
    });

    it("refuses the clock fields the database owns", () => {
        expect(omitted("    /**\n     * @createdAt\n     */", "madeAt?: Date;")).toEqual(["madeAt"]);
        expect(omitted("    /**\n     * @updatedAt\n     */", "changedAt?: Date;")).toEqual(["changedAt"]);
    });

    it("refuses a relation, which is written through the target's own repository", () => {
        expect(omitted("    /**\n     * @relation\n     */", "customer?: Customer;")).toEqual(["customer"]);
    });

    it("refuses the children of an aggregate, which belong to the child's table", () => {
        expect(omitted("    /**\n     * @children\n     */", "rows?: Row[];")).toEqual(["rows"]);
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
