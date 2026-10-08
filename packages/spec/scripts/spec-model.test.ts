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

    it("decodes @queryFilter as a bare marker", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @queryFilter\n     */", "code: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toBe(true);
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

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toBe(true);
    });

    it("does not treat a field named id as the primary key", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName ID\n     */", "id: ThingId;"),
        });

        const tags = interfaces.get("Thing")?.properties[0]?.tags;

        expect(tags?.primaryKey).toBe(false);
        expect(tags?.queryFilter).toBe(false);
    });

    it("does not make another field a filter by default", () => {
        const { interfaces } = parse({
            "Thing.ts": thing("    /**\n     * @fieldName Label\n     */", "label: string;"),
        });

        expect(interfaces.get("Thing")?.properties[0]?.tags.queryFilter).toBe(false);
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

    it("refuses the clock fields the database owns", () => {
        expect(omitted("    /**\n     * @createdAt\n     */", "madeAt?: Date;")).toEqual(["madeAt"]);
        expect(omitted("    /**\n     * @updatedAt\n     */", "changedAt?: Date;")).toEqual(["changedAt"]);
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

    it("keeps a defaulted field out of the optional set when it is not insertable", () => {
        const doc = "    /**\n     * @version\n     * @pgDefault 0\n     */";
        expect(omitted(doc, "version?: number;")).toEqual(["version"]);
        expect(defaultedInsertProperties(spec(doc, "version?: number;"))).toEqual([]);
    });

    it("writes a version that carries no default, since the database has nothing to fall back on", () => {
        expect(omitted("    /**\n     * @version\n     */", "version?: number;")).toEqual([]);
    });

    it("refuses the clock fields and virtual columns the database owns outright", () => {
        expect(omitted("    /**\n     * @createdAt\n     */", "madeAt?: Date;")).toEqual(["madeAt"]);
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
