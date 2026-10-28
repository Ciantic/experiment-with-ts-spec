/** Unit tests for parseSpec, driven by self-contained fixtures. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { SPEC_SRC_ROOT, collectAliases, defaultedInsertProperties, omittedFromInsert, omittedFromPatch, parseInMemorySpec, primaryKeyProperties, readTags, resolveType, type TypeResolution } from "./spec-model.ts";

const GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** Parse an in-memory spec, so no test reads the real domain. */
function parse(files: Record<string, string>) {
    const spec = Object.entries(files).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", name),
        sourceFileText,
    }));
    return parseInMemorySpec(spec, { sourceGlob: GLOB });
}

describe("parseSpec interfaces", () => {
    it("snake-cases the table name by default", () => {
        const { interfaces } = parse({ "LineItem.ts": "/** @entity */\nexport interface LineItem { id: string; }" });

        expect(interfaces.get("LineItem")?.pgTableName).toBe("line_item");
    });

    it("lets @pgTable override the table name", () => {
        const { interfaces } = parse({
            "Person.ts": "/**\n * @entity\n * @pgTable people\n */\nexport interface Person { id: string; }",
        });

        expect(interfaces.get("Person")?.pgTableName).toBe("people");
    });

    it("maps a source file back to its package import specifier", () => {
        const { interfaces } = parse({ "Thing.ts": "/** @entity */\nexport interface Thing { id: string; }" });

        expect(interfaces.get("Thing")?.importSpecifier).toBe("spec/fixtures/Thing.ts");
    });

    it("decodes an interface-level @pgTrigger", () => {
        const { interfaces } = parse({
            "Thing.ts":
                '/**\n * @entity\n * @pgTable thing\n * @pgTrigger after insert or update: insert into "log" ("id") values (NEW."id")\n */\nexport interface Thing { id: string; }',
        });

        expect(interfaces.get("Thing")?.trigger).toEqual({
            timing: "after",
            events: ["insert", "update"],
            statement: 'insert into "log" ("id") values (NEW."id")',
        });
    });

    it("leaves an interface without @pgTrigger undefined", () => {
        const { interfaces } = parse({ "Thing.ts": "/** @entity */\nexport interface Thing { id: string; }" });

        expect(interfaces.get("Thing")?.trigger).toBeUndefined();
    });

    it("ignores an interface that carries no @entity", () => {
        const { interfaces } = parse({
            "Contract.ts": "export interface Contract { list(): void; }",
            "Thing.ts": "/** @entity */\nexport interface Thing { id: string; }",
        });

        expect([...interfaces.keys()]).toEqual(["Thing"]);
    });

    it("collects the interface's properties with their option flags", () => {
        const { interfaces } = parse({
            "Thing.ts": "/** @entity */\nexport interface Thing { id: string; note?: string; }",
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
        `/** @entity */\nexport interface Thing {\n${doc}\n    ${field}\n}`;

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
            "Thing.ts": thing("    /**\n     * @unique\n     */", "code: string;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.unique).toBe(true);
        expect(tags?.version).toBe(false);
    });

    it("decodes @computed as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @computed\n     * @pgTrigger NEW.\"net\" := NEW.\"q\" * NEW.\"p\"\n     */", "net: Decimal;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.computed).toBe(true);
        expect(tags?.pgTrigger).toEqual({
            timing: "before",
            events: ["insert", "update"],
            statement: 'NEW."net" := NEW."q" * NEW."p"',
        });
        expect(tags?.pgVirtual).toBeUndefined();
    });

    it("decodes a @pgTrigger header naming the table, timing, and events", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @computed\n     * @pgTrigger after insert or update or delete on Child: update \"parent\" set \"n\" = 1 where \"id\" in (OLD.\"parentId\", NEW.\"parentId\")\n     */",
                "net: Decimal;",
            ),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.pgTrigger).toEqual({
            table: "Child",
            timing: "after",
            events: ["insert", "update", "delete"],
            statement: 'update "parent" set "n" = 1 where "id" in (OLD."parentId", NEW."parentId")',
        });
    });

    it("decodes a @pgTrigger header without a table as the field's own", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @computed\n     * @pgTrigger after insert: insert into \"log\" (\"id\") values (NEW.\"id\")\n     */",
                "logged?: Decimal;",
            ),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.pgTrigger).toEqual({
            timing: "after",
            events: ["insert"],
            statement: 'insert into "log" ("id") values (NEW."id")',
        });
    });

    it("decodes the level a @pgTrigger header names", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @computed\n     * @pgTrigger after insert for each statement: insert into \"log\" (\"id\") values (1)\n     */",
                "logged?: Decimal;",
            ),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.pgTrigger?.level).toBe("statement");
    });

    it("leaves the level unset when the header names none", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @computed\n     * @pgTrigger after insert on Child: update \"parent\" set \"n\" = 1\n     */",
                "net?: Decimal;",
            ),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.pgTrigger?.level).toBeUndefined();
    });

    it("decodes the clock tags and the virtual expression", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @computed\n     * @pgVirtual \"net\" + \"tax\"\n     */", "total?: Decimal;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.pgVirtual).toBe('"net" + "tax"');
    });

    it("keeps duplicate tags in the raw map", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @unique\n     * @unique\n     */", "code: string;"),
        });

        const byName = interfaces.get("Thing")?.properties[0]?.tags.written.byName;

        expect(byName?.get("unique")).toHaveLength(2);
    });

    it("decodes @deletedAt as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @deletedAt\n     */", "deletedAt?: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.deletedAt).toBe(true);
    });

    it("leaves a field without @deletedAt unflagged", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName Label\n     */", "label: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.deletedAt).toBe(false);
    });

    it("decodes @queryFilter as an optional filter", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: false });
    });

    it("decodes @queryFilter required", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter required\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: true });
    });

    it("leaves an @queryFilter value the linter rejects as optional", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter yes\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: false });
    });

    it("decodes @queryFilter default=isNull as a null test", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=isNull\n     */", "code?: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "isNull" },
        });
    });

    it("decodes @queryFilter default=isNotNull as a not-null test", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=isNotNull\n     */", "code?: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "isNotNull" },
        });
    });

    it("keeps the retired default=null spelling out of the model, for the linter to report", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=null\n     */", "code?: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: false });
    });

    it("decodes a numeric filter default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=0\n     */", "code: number;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: 0 },
        });
    });

    it("decodes a boolean filter default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=true\n     */", "code: boolean;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: true },
        });
    });

    it("decodes a bare filter default as a string, so a date or an enum value needs no quotes", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=draft\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: "draft" },
        });
    });

    it("decodes a quoted filter default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing('    /**\n     * @queryFilter default="draft"\n     */', "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: "draft" },
        });
    });

    it("keeps a quoted null keyword a string, so a text column can default to that text", () => {
        const { interfaces } = parse({
            "Thing.ts": thing('    /**\n     * @queryFilter default="isNull"\n     */', "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: "isNull" },
        });
    });

    it("keeps a quoted filter default containing spaces in one value", () => {
        const { interfaces } = parse({
            "Thing.ts": thing('    /**\n     * @queryFilter default="on hold"\n     */', "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: "on hold" },
        });
    });

    it("keeps an integer too large for a JS number as the exact text, so an int8 literal is not rounded", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter default=9007199254740993\n     */", "code: bigint;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: false,
            default: { kind: "literal", value: "9007199254740993" },
        });
    });

    it("decodes both options when one tag carries them", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter required default=isNull\n     */", "code?: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({
            required: true,
            default: { kind: "isNull" },
        });
    });

    it("decodes @primaryKey as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @primaryKey\n     */", "id: ThingId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.primaryKey).toBe(true);
        expect(tags?.foreignKey).toBeUndefined();
    });

    it("decodes @pgAutoIncrement as a bare marker, off by default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @primaryKey\n     */",
                "id: ThingId;\n    /**\n     * @primaryKey\n     * @pgAutoIncrement\n     */\n    counter: Counter;",
            ),
        });

        const [id, counter] = interfaces.get("Thing")?.properties ?? [];

        expect(id?.tags.pgAutoIncrement).toBe(false);
        expect(counter?.tags.pgAutoIncrement).toBe(true);
    });

    it("decodes @foreignKey with the interface it references", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @foreignKey Owner\n     */", "ownerId?: OwnerId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.foreignKey).toEqual({ entity: "Owner" });
        expect(tags?.primaryKey).toBe(false);
    });

    it("decodes @foreignKey options into referential actions", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @foreignKey Owner onDelete=cascade onUpdate=setNull\n     */", "ownerId?: OwnerId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.foreignKey).toEqual({ entity: "Owner", onDelete: "cascade", onUpdate: "setNull" });
    });

    it("decodes @foreignKey scope as a field name beside the actions", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @foreignKey Owner onDelete=cascade scope=tenantId\n     */",
                "ownerId?: OwnerId;",
            ),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.foreignKey).toEqual({ entity: "Owner", onDelete: "cascade", scope: "tenantId" });
    });

    it("leaves an empty @foreignKey scope as no scope", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @foreignKey Owner scope=\n     */", "ownerId?: OwnerId;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.foreignKey?.scope).toBeUndefined();
    });

    it("keeps the entity when @foreignKey carries no options", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @foreignKey Owner onDelete=restrict\n     */", "ownerId?: OwnerId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.foreignKey?.entity).toBe("Owner");
        expect(tags?.foreignKey?.onDelete).toBe("restrict");
        expect(tags?.foreignKey?.onUpdate).toBeUndefined();
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

    it("makes the @primaryKey field an optional filter without the tag", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName ID\n     * @primaryKey\n     */", "id: ThingId;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: false });
    });

    it("keeps a primary key that declares its filter required", () => {
        const { interfaces } = parse({
            "Thing.ts": thing(
                "    /**\n     * @fieldName ID\n     * @primaryKey\n     * @queryFilter required\n     */",
                "id: ThingId;",
            ),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: true });
    });

    it("does not treat a field named id as the primary key", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName ID\n     */", "id: ThingId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.primaryKey).toBe(false);
        expect(tags?.queryFilter).toBeUndefined();
    });

    it("does not make another field a filter by default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName Label\n     */", "label: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toBeUndefined();
    });

    it("decodes a bare @queryOrderBy", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryOrderBy\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryOrderBy).toEqual({});
    });

    it("decodes @queryOrderBy default asc", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryOrderBy default asc\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryOrderBy).toEqual({ default: "asc" });
    });

    it("leaves an @queryOrderBy value the linter rejects as no default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryOrderBy sideways\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryOrderBy).toEqual({});
    });

    it("decodes @queryWhere operators in declaration order", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryWhere gte lte\n     */", "at: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryWhere).toEqual(["gte", "lte"]);
    });

    it("decodes a bare @queryWhere as an empty operator list", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryWhere\n     */", "at: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryWhere).toEqual([]);
    });

    it("leaves where undefined when the tag is absent", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName At\n     */", "at: Date;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryWhere).toBeUndefined();
    });
});

describe("parseSpec clock tags", () => {
    it("decodes @createdAt and @updatedAt as bare markers", () => {
        const { interfaces } = parse({
            "Thing.ts": [
                "/** @entity */\nexport interface Thing {",
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
    const field = (doc: string, declaration: string) => `/** @entity */\nexport interface Thing {\n${doc}\n    ${declaration}\n}`;
    const omitted = (doc: string, declaration: string) => {
        const spec = parse({ "Thing.ts": field(doc, declaration) }).interfaces.get("Thing")!;
        return omittedFromPatch(spec).map((property) => property.name);
    };

    it("keeps a plain field patchable", () => {
        expect(omitted("    /**\n     * @fieldName Label\n     */", "label?: string;")).toEqual([]);
    });

    it("keeps a defaulted field patchable, so a caller may override the default", () => {
        expect(omitted("    /**\n     * @pgDefault now()\n     */", "createdAt?: Date;")).toEqual([]);
    });

    it("keeps the version patchable, because a patch carries it to lock the row", () => {
        expect(omitted("    /**\n     * @version\n     * @pgDefault 0\n     */", "version?: number;")).toEqual([]);
    });

    it("refuses a nullable computation the trigger derives", () => {
        expect(omitted('    /**\n     * @computed\n     * @pgTrigger NEW."net" := NEW."q" * NEW."p"\n     */', "net?: Money;")).toEqual(["net"]);
    });

    it("keeps a required trigger computation, which the caller alone can supply", () => {
        expect(omitted('    /**\n     * @computed\n     * @pgTrigger NEW."net" := NEW."q" * NEW."p"\n     */', "net: Money;")).toEqual([]);
    });

    it("refuses a virtual generated column even when the field is required", () => {
        expect(omitted('    /**\n     * @computed\n     * @pgVirtual "net" + "tax"\n     */', "total: Money;")).toEqual(["total"]);
    });

    it("refuses the creation clock but writes the update clock", () => {
        expect(omitted("    /**\n     * @createdAt\n     */", "madeAt?: Date;")).toEqual(["madeAt"]);
        expect(omitted("    /**\n     * @updatedAt\n     */", "changedAt?: Date;")).toEqual([]);
    });

    it("keeps an assigned key patchable, because the key addresses the row a patch writes", () => {
        const doc = "    /**\n     * @primaryKey\n     * @pgAutoIncrement\n     */";

        expect(omitted(doc, "id: Counter;")).toEqual([]);
    });

    it("refuses a relation, which is written through the target's own repository", () => {
        expect(omitted("    /**\n     * @relation\n     */", "customer?: Customer;")).toEqual(["customer"]);
    });

    it("refuses the children of an aggregate, which belong to the child's table", () => {
        expect(omitted("    /**\n     * @children\n     */", "rows?: Row[];")).toEqual(["rows"]);
    });
});

describe("insert field rules", () => {
    /** The tag block for one field, and the field itself. */
    const field = (doc: string, declaration: string) => `/** @entity */\nexport interface Thing {\n${doc}\n    ${declaration}\n}`;
    const spec = (doc: string, declaration: string) =>
        parse({ "Thing.ts": field(doc, declaration) }).interfaces.get("Thing")!;
    const omitted = (doc: string, declaration: string) =>
        omittedFromInsert(spec(doc, declaration)).map((property) => property.name);

    it("writes a defaulted field, so a caller may override the default", () => {
        const doc = "    /**\n     * @pgDefault now()\n     */";
        expect(omitted(doc, "createdAt?: Date;")).toEqual([]);
        expect(defaultedInsertProperties(spec(doc, "createdAt?: Date;")).map((property) => property.name)).toEqual([
            "createdAt",
        ]);
    });

    it("relaxes a defaulted version, so a create may claim one or take the default", () => {
        const doc = "    /**\n     * @version\n     * @pgDefault 0\n     */";
        expect(omitted(doc, "version?: number;")).toEqual([]);
        expect(defaultedInsertProperties(spec(doc, "version?: number;")).map((property) => property.name)).toEqual([
            "version",
        ]);
    });

    it("writes a version that carries no default, since the database has nothing to fall back on", () => {
        expect(omitted("    /**\n     * @version\n     */", "version?: number;")).toEqual([]);
    });

    it("writes both clock fields, and only a virtual column stays the database's", () => {
        expect(omitted("    /**\n     * @createdAt\n     */", "madeAt?: Date;")).toEqual([]);
        expect(omitted("    /**\n     * @updatedAt\n     */", "changedAt?: Date;")).toEqual([]);
        expect(omitted('    /**\n     * @computed\n     * @pgVirtual "net" + "tax"\n     */', "total: Money;")).toEqual([
            "total",
        ]);
    });

    it("refuses an assigned key, which the database fills and a create reads back", () => {
        expect(omitted("    /**\n     * @primaryKey\n     * @pgAutoIncrement\n     */", "id: Counter;")).toEqual(["id"]);
    });

    it("refuses a nullable computation but keeps a required one", () => {
        const trigger = '    /**\n     * @computed\n     * @pgTrigger NEW."net" := NEW."q" * NEW."p"\n     */';
        expect(omitted(trigger, "net?: Money;")).toEqual(["net"]);
        expect(omitted(trigger, "net: Money;")).toEqual([]);
    });

    it("refuses a branch, which is written through the target's own repository", () => {
        expect(omitted("    /**\n     * @relation\n     */", "customer?: Customer;")).toEqual(["customer"]);
        expect(omitted("    /**\n     * @children\n     */", "rows?: Row[];")).toEqual(["rows"]);
    });

    it("leaves an inlined branch alone, since it has no single column to default", () => {
        expect(defaultedInsertProperties(spec("    /**\n     * @inlined\n     * @pgDefault '{}'\n     */", "snapshot?: Snapshot;"))).toEqual(
            [],
        );
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

        expect(tags.written.byName.has("fieldName")).toBe(true);
        expect(tags.fieldName).toBeUndefined();
    });

    it("keeps every tag in source order, which a rule reporting each occurrence needs", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            "/Thing.ts",
            `/**
 * @pgTable thing
 * @unknownOne
 * @unknownTwo
 * @unknownOne
 */
export interface Thing {
    id: string;
}`,
        );

        const tags = readTags(sourceFile.getInterfaces()[0]!);

        expect(tags.written.all.map((tag) => tag.name)).toEqual([
            "pgTable",
            "unknownOne",
            "unknownTwo",
            "unknownOne",
        ]);
        expect(tags.written.byName.get("unknownOne")?.map((tag) => tag.line)).toEqual([3, 5]);
    });

    it("carries each tag's text trimmed, and none when it has no comment", () => {
        const project = new Project({ useInMemoryFileSystem: true });
        const sourceFile = project.createSourceFile(
            "/Thing.ts",
            "export interface Thing {\n    /**\n     * @fieldName  Label  \n     * @primaryKey\n     */\n    id: string;\n}",
        );

        const tags = readTags(sourceFile.getInterfaces()[0]!.getProperties()[0]!);
        const fieldName = tags.written.byName.get("fieldName")?.[0];

        expect(fieldName?.value).toBe("Label");
        expect(tags.written.byName.get("primaryKey")?.[0]?.value).toBeUndefined();
    });
});

describe("interface tags", () => {
    it("exposes the interface's own tags as written", () => {
        const { interfaces } = parse({
            "Thing.ts": "/**\n * @entity\n * @pgTable things\n * @repository create\n */\nexport interface Thing { id: string; }",
        });

        const tags = interfaces.get("Thing")?.tags;

        expect(tags?.pgTable).toBe("things");
        expect(tags?.written.all.map((tag) => tag.name)).toEqual(["entity", "pgTable", "repository"]);
    });
});

describe("tenancy tags", () => {
    /** An entity whose own tags are `tags`, with the given field declarations. */
    function entity(name: string, tags: string[], fields: string): string {
        const doc = ["entity", ...tags].map((tag) => ` * @${tag}`).join("\n");
        return `/**\n${doc}\n */\nexport interface ${name} {\n${fields}\n}`;
    }

    /** A field referencing `target`, with the options as written after it. */
    function link(target: string, options = ""): string {
        return `    /**\n     * @foreignKey ${target}${options}\n     */\n    ownerId: OwnerId;`;
    }

    it("decodes @tenant as a bare marker, off by default", () => {
        const { interfaces } = parse({
            "Root.ts": entity("Root", ["tenant"], "    id: RootId;"),
            "Plain.ts": entity("Plain", [], "    id: PlainId;"),
        });

        expect(interfaces.get("Root")?.tags.tenant).toBe(true);
        expect(interfaces.get("Plain")?.tags.tenant).toBe(false);
    });

    it("decodes @tenantOwned as the column that scopes the interface", () => {
        const { interfaces } = parse({
            "Thing.ts": entity("Thing", ["tenantOwned ownerId"], "    ownerId: OwnerId;"),
        });

        expect(interfaces.get("Thing")?.tags.tenantOwned).toBe("ownerId");
    });

    it("decodes @foreignKey scope as written", () => {
        const { interfaces } = parse({
            "Owner.ts": entity("Owner", ["tenantOwned ownerId"], "    ownerId: OwnerId;"),
            "Thing.ts": entity("Thing", [], link("Owner", " scope=ownerId")),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.foreignKey).toEqual({ entity: "Owner", scope: "ownerId" });
    });

    it("decodes a reference that declares no scope without one", () => {
        const { interfaces } = parse({
            "Owner.ts": entity("Owner", ["tenantOwned ownerId"], "    ownerId: OwnerId;"),
            "Thing.ts": entity("Thing", [], link("Owner")),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.foreignKey).toEqual({ entity: "Owner" });
    });

    it("decodes a scope that disagrees with the target as written", () => {
        const { interfaces } = parse({
            "Owner.ts": entity("Owner", ["tenantOwned ownerId"], "    ownerId: OwnerId;"),
            "Thing.ts": entity("Thing", [], link("Owner", " scope=otherId")),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.foreignKey).toEqual({ entity: "Owner", scope: "otherId" });
    });

    it("keeps a referential action beside the scope", () => {
        const { interfaces } = parse({
            "Thing.ts": entity("Thing", [], link("Owner", " onDelete=cascade scope=otherId")),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.foreignKey).toEqual({
            entity: "Owner",
            onDelete: "cascade",
            scope: "otherId",
        });
    });

    it("decodes a filter on the owned column like any other @queryFilter", () => {
        const { interfaces } = parse({
            "Thing.ts": entity(
                "Thing",
                ["tenantOwned ownerId"],
                "    /**\n     * @queryFilter required\n     */\n    ownerId: OwnerId;",
            ),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toEqual({ required: true });
    });

    it("ignores a bare @tenantOwned, which names nothing", () => {
        const { interfaces } = parse({
            "Thing.ts": entity("Thing", ["tenantOwned"], "    ownerId: OwnerId;"),
        });

        expect(interfaces.get("Thing")?.tags.tenantOwned).toBeUndefined();
    });
});

describe("alias storage types", () => {
    /** The `pgType` each alias in the fixture resolves to. */
    function storage(files: Record<string, string>): Record<string, string | undefined> {
        const { aliases } = parse(files);
        return Object.fromEntries([...aliases].map(([name, alias]) => [name, alias.tags.pgType]));
    }

    it("keeps the @pgType an alias declares", () => {
        expect(
            storage({
                "primitives.ts": `/**
 * @primitive
 * @pgType uuid
 * @zod z.uuid()
 */
export type GUID = string;`,
            }),
        ).toEqual({ GUID: "uuid" });
    });

    it("fills the bare keyword default an alias does not declare", () => {
        expect(storage({ "Thing.ts": "export type Note = string;" })).toEqual({ Note: "text" });
        expect(storage({ "Thing.ts": "export type Moment = Date;" })).toEqual({ Moment: "timestamptz" });
    });

    it("inherits the storage of the alias it names", () => {
        expect(
            storage({
                "primitives.ts": `/**
 * @primitive
 * @pgType uuid
 * @zod z.uuid()
 */
export type BrandedId<Name extends string> = string & $brand<Name>;`,
                "Thing.ts": 'export type ThingId = BrandedId<"ThingId">;',
            }),
        ).toEqual({ BrandedId: "uuid", ThingId: "uuid" });
    });

    it("reads storage out of an intersection", () => {
        expect(storage({ "Thing.ts": 'export type Version = bigint & $brand<"Version">;' })).toEqual({
            Version: "int8",
        });
    });

    it("inherits through an alias that resolves to another alias", () => {
        expect(
            storage({
                "primitives.ts": `/**
 * @primitive
 * @pgType integer
 * @zod z.number().int()
 */
export type AutoIncrement<Name extends string> = number & $brand<Name>;`,
                "Thing.ts": 'export type ThingId = AutoIncrement<"ThingId">;',
            }),
        ).toEqual({ AutoIncrement: "integer", ThingId: "integer" });
    });

    it("leaves a union unresolved, since the CHECK constraint is the backend's", () => {
        expect(storage({ "Thing.ts": 'export type Status = "pending" | "sent";' })).toEqual({
            Status: undefined,
        });
    });

    it("leaves an array and an entity unresolved, which name a cardinality rather than a storage type", () => {
        expect(
            storage({
                "Thing.ts": "export type Lines = string[];",
                "Other.ts": "export interface Other { id: string; }\nexport type That = Other;",
            }),
        ).toEqual({ Lines: undefined, That: undefined });
    });

    it("terminates on an alias that refers to itself", () => {
        expect(storage({ "Thing.ts": "export type Loop = Loop;" })).toEqual({ Loop: undefined });
    });

    it("terminates on a cycle between two aliases", () => {
        expect(
            storage({ "Thing.ts": "export type First = Second;\nexport type Second = First;" }),
        ).toEqual({ First: undefined, Second: undefined });
    });
});

describe("alias defaults", () => {
    /** A primitive that names the expression the database applies when a column of it is omitted. */
    const UUIDV7 = `/**
 * @primitive
 * @pgType uuid
 * @pgDefault uuidv7()
 * @zod z.uuidv7()
 */
export type UUIDv7 = string;`;

    /** The effective `pgDefault` of one field, through the aliases in the fixture. */
    function fieldDefault(files: Record<string, string>, entity = "Thing", field = "id") {
        const { interfaces } = parse(files);
        return interfaces.get(entity)?.properties.find((property) => property.name === field)?.tags.pgDefault;
    }

    it("inherits a primitive's default through an intersection and an alias", () => {
        expect(
            fieldDefault({
                "primitives.ts": `${UUIDV7}\nexport type ThingId = UUIDv7 & $brand<"ThingId">;`,
                "Thing.ts": "/** @entity */\nexport interface Thing {\n    /** @primaryKey */\n    id: ThingId;\n}",
            }),
        ).toBe("uuidv7()");
    });

    it("fills the default on the alias itself", () => {
        const { aliases } = parse({
            "primitives.ts": `${UUIDV7}\nexport type ThingId = UUIDv7 & $brand<"ThingId">;`,
        });

        expect(aliases.get("ThingId")?.tags.pgDefault).toBe("uuidv7()");
    });

    it("lets a field override the default its type supplies", () => {
        expect(
            fieldDefault({
                "primitives.ts": UUIDV7,
                "Thing.ts":
                    "/** @entity */\nexport interface Thing {\n    /** @pgDefault gen_random_uuid() */\n    id: UUIDv7;\n}",
            }),
        ).toBe("gen_random_uuid()");
    });

    it("lets an empty field tag clear the default its type supplies", () => {
        expect(
            fieldDefault({
                "primitives.ts": UUIDV7,
                "Thing.ts": "/** @entity */\nexport interface Thing {\n    /** @pgDefault */\n    id: UUIDv7;\n}",
            }),
        ).toBeUndefined();
    });

    it("never inherits onto a foreign key, whose value is copied from another row", () => {
        const files = {
            "primitives.ts": UUIDV7,
            "Thing.ts":
                "/** @entity */\nexport interface Thing {\n    /** @primaryKey */\n    id: UUIDv7;\n    /** @foreignKey Owner */\n    ownerId: UUIDv7;\n}",
        };

        expect(fieldDefault(files)).toBe("uuidv7()");
        expect(fieldDefault(files, "Thing", "ownerId")).toBeUndefined();
    });
});

describe("operations", () => {
    const contract = `
export interface InvoiceOperations<T> {
    /**
     * Send the invoice to the recipient.
     *
     * @throws {InvoiceDetailsError} thrown when details are missing
     * @operation
     * @restOperation
     */
    sendInvoice(ctx: T, opts: { invoice: string }): Promise<string>;

    list(ctx: T): void;
}`;

    it("reads a method carrying @operation", () => {
        const spec = parse({ "Ops.ts": contract });

        expect(spec.operations).toHaveLength(1);
        expect(spec.operations[0]).toMatchObject({
            interfaceName: "InvoiceOperations",
            interfaceTypeParameters: ["T"],
            name: "sendInvoice",
            description: ["Send the invoice to the recipient."],
            parameters: [
                { name: "ctx", typeText: "T" },
                { name: "opts", typeText: "{ invoice: string }" },
            ],
            returnTypeText: "Promise<string>",
            operation: true,
            rest: true,
        });
    });

    it("defers an entity carrying @todo from the generated set", () => {
        const spec = parse({
            "Draft.ts": "/**\n * @entity\n * @todo decide the fields\n */\nexport interface Draft { id: string; }",
            "Ready.ts": "/** @entity */\nexport interface Ready { id: string; }",
        });

        expect([...spec.interfaces.keys()]).toEqual(["Ready"]);
        expect(spec.todoInterfaces.map((entity) => [entity.name, entity.todo])).toEqual([["Draft", "decide the fields"]]);
    });

    it("defers an operation carrying @todo, keeping it out of the generated set", () => {
        const spec = parse({
            "Ops.ts": `
export interface InvoiceOperations<T> {
    /** @operation */
    sendInvoice(ctx: T): Promise<string>;

    /**
     * @operation
     * @todo settle the input shape
     */
    voidInvoice(ctx: T): Promise<string>;
}`,
        });

        expect(spec.operations.map((operation) => operation.name)).toEqual(["sendInvoice"]);
        expect(spec.todoOperations.map((operation) => [operation.name, operation.todo])).toEqual([
            ["voidInvoice", "settle the input shape"],
        ]);
    });

    it("defers every operation of a contract carrying @todo", () => {
        const spec = parse({
            "Ops.ts": `
/** @todo finish the area */
export interface InvoiceOperations<T> {
    /** @operation */
    sendInvoice(ctx: T): Promise<string>;
}`,
        });

        expect(spec.operations).toEqual([]);
        expect(spec.todoOperations.map((operation) => operation.name)).toEqual(["sendInvoice"]);
    });

    it("resolves the promise's argument as the result type", () => {
        const spec = parse({ "Ops.ts": contract });

        expect(spec.operations[0]).toMatchObject({
            returnTypeText: "Promise<string>",
            returnType: { kind: "reference", name: "Promise", arguments: ["string"] },
            resultTypeText: "string",
            resultType: { kind: "keyword", name: "string" },
        });
    });

    it("reads the class and reason of a @throws tag", () => {
        const spec = parse({ "Ops.ts": contract });

        expect(spec.operations[0]?.throws).toEqual([
            {
                name: "InvoiceDetailsError",
                reason: "thrown when details are missing",
                parameters: new Map(),
                location: expect.objectContaining({ line: expect.any(Number) }),
            },
        ]);
    });

    it("reads a status parameter off the tag, leaving it out of the reason", () => {
        const spec = parse({
            "Ops.ts": `
export interface Ops<T> {
    /**
     * @throws {InvoiceDetailsError} status=422 when details are missing
     * @operation
     */
    send(ctx: T): Promise<void>;
}`,
        });

        expect(spec.operations[0]?.throws[0]).toMatchObject({
            name: "InvoiceDetailsError",
            status: 422,
            reason: "when details are missing",
        });
    });

    it("reads the verb and the path off @restOperation", () => {
        const spec = parse({
            "Ops.ts": `
export interface Ops<T> {
    /**
     * @operation
     * @restOperation POST /invoice/send
     */
    send(ctx: T): Promise<void>;

    /**
     * @operation
     * @restOperation
     */
    other(ctx: T): Promise<void>;
}`,
        });

        expect(spec.operations.find((operation) => operation.name === "send")).toMatchObject({
            rest: true,
            restMethod: "POST",
            restPath: "/invoice/send",
        });
        // A malformed tag stays absent, so the linter reports it rather than a generator inventing a route.
        expect(spec.operations.find((operation) => operation.name === "other")?.restMethod).toBeUndefined();
        expect(spec.operations.find((operation) => operation.name === "other")?.restPath).toBeUndefined();
    });

    it("keeps @restOperation without @operation, so lint can report it", () => {
        const spec = parse({
            "Ops.ts": `
export interface Ops<T> {
    /** @restOperation */
    send(ctx: T): Promise<void>;
}`,
        });

        expect(spec.operations).toEqual([
            expect.objectContaining({ name: "send", operation: false, rest: true }),
        ]);
    });

    it("ignores a method carrying neither marker", () => {
        const spec = parse({ "Ops.ts": contract });

        expect(spec.operations.map((operation) => operation.name)).toEqual(["sendInvoice"]);
    });
});

describe("resolveType", () => {
    /** What the `Target` alias resolves to, with its siblings as the alias graph. */
    function resolution(text: string): TypeResolution {
        const project = new Project({ useInMemoryFileSystem: true });
        project.createSourceFile("/spec.ts", text);
        const aliases = collectAliases(project);
        const alias = aliases.get("Target");
        if (!alias) {
            throw new Error(`the fixture declares no Target alias: ${text}`);
        }
        return resolveType(alias.type, aliases);
    }

    it("names the storage and the JavaScript type of a keyword", () => {
        expect(resolution("export type Target = bigint;")).toEqual({ storage: "int8", jsType: "bigint" });
    });

    it("names both for a built-in the spec uses", () => {
        expect(resolution("export type Target = Date;")).toEqual({ storage: "timestamptz", jsType: "Date" });
    });

    it("takes a referenced alias's declared storage, with the JavaScript type of its own type", () => {
        expect(
            resolution(`/**
 * @primitive
 * @pgType decimal
 * @zod z.string()
 */
export type Decimal = string & $brand<"Decimal">;
export type Target = Decimal & $brand<"Target">;`),
        ).toEqual({ storage: "decimal", jsType: "string" });
    });

    it("names nothing for a body that is only a brand, since the alias's own tag is the caller's", () => {
        expect(resolution('export type Target = $brand<"Target">;')).toEqual({
            storage: undefined,
            jsType: undefined,
        });
    });

    it("keeps the JavaScript type of a union whose members agree, without inventing a storage type", () => {
        expect(resolution('export type Target = "a" | "b" | (string & {});')).toEqual({
            storage: undefined,
            jsType: "string",
        });
    });

    it("gives up on a union whose members disagree", () => {
        expect(resolution("export type Target = string | number;").jsType).toBeUndefined();
    });

    it("carries only the element's JavaScript type for an array", () => {
        expect(resolution("export type Target = bigint[];")).toEqual({ storage: undefined, jsType: "bigint" });
    });

    it("names neither for an entity", () => {
        expect(
            resolution(`export interface Other { id: string; }
                export type Target = Other;`),
        ).toEqual({ storage: undefined, jsType: undefined });
    });

    it("terminates on an alias that refers to itself", () => {
        expect(resolution("export type Target = Target;")).toEqual({ storage: undefined, jsType: undefined });
    });
});
