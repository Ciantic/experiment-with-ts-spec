/** Unit tests for the Zod generator, driven by self-contained fixtures. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { buildZodModel, type Diagnostic } from "./zod-model.ts";
import {
    domainModuleName,
    generateDomainEntity,
    generateInsertSchema,
    generatePatchSchema,
    generatePrimitives,
    generatePrimaryKeySchema,
    generateQueryFile,
    generateUpsertSchema,
    generateZodSchemas,
    insertModuleName,
    patchModuleName,
    primaryKeyModuleName,
    upsertModuleName,
} from "./generate-zod-schemas.ts";

const SPEC_GLOB = "fixtures/domain/**/*.ts";

interface Fixture {
    domain: Record<string, string>;
}

/** Primitive aliases a fixture field can reference, each declaring its own Zod schema. */
const PRIMITIVES = `
/**
 * @primitive
 * @pgType uuid
 * @zod z.uuid()
 */
export type GUID = string;

/**
 * @primitive
 * @pgType uuid
 * @zod z.uuid().brand<Name>()
 */
export type BrandedId<Name extends string> = GUID & $brand<Name>;

/**
 * @primitive
 * @pgType decimal
 * @zod z.string().regex(/^-?\\d+(\\.\\d+)?$/).brand<"Money">()
 */
export type Money = string;

/**
 * @primitive
 * @pgType text
 * @zod z.enum(["fi", "sv"]).or(z.string())
 */
export type Language = "fi" | "sv" | (string & {});

/**
 * @primitive
 * @pgType int8
 * @zod z.bigint().brand<"Version">()
 */
export type Version = bigint;
`.trim();

/** Generate from an in-memory project, so no fixture depends on the real spec. */
function generate(fixture: Fixture) {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("fixtures/domain/primitives.ts", PRIMITIVES);
    for (const [name, text] of Object.entries(fixture.domain)) {
        project.createSourceFile(`fixtures/domain/${name}.ts`, text);
    }
    const model = buildZodModel(project, { specGlob: SPEC_GLOB, aliasGlob: SPEC_GLOB });
    return { model, files: generateZodSchemas(model), diagnostics: model.diagnostics };
}

function messages(diagnostics: Diagnostic[]): string[] {
    return diagnostics.map((diagnostic) => diagnostic.message);
}

/** The rendered 1:1 schema module for a fixture entity, e.g. `Thing` -> `domain/thingSchema.ts`. */
function domainFile(files: Map<string, string>, entity: string): string {
    return files.get(join("domain", domainModuleName(entity))) ?? "";
}

/** The rendered insert module for a fixture entity, e.g. `Thing` -> `repositories/thingInsertSchema.ts`. */
function insertFile(files: Map<string, string>, entity: string): string {
    return files.get(join("repositories", insertModuleName(entity))) ?? "";
}

/** The rendered patch module for a fixture entity. */
function patchFile(files: Map<string, string>, entity: string): string {
    return files.get(join("repositories", patchModuleName(entity))) ?? "";
}

/** The rendered by-key module for a fixture entity. */
function primaryKeyFile(files: Map<string, string>, entity: string): string {
    return files.get(join("repositories", primaryKeyModuleName(entity))) ?? "";
}

/** The rendered upsert module for a fixture entity. */
function upsertFile(files: Map<string, string>, entity: string): string {
    return files.get(join("repositories", upsertModuleName(entity))) ?? "";
}

/** A field that resolves to an entity, a primitive, and an open-union alias. */
const THING = `
import type { BrandedId } from "./primitives.ts";

/** The identifier of a thing. */
export type ThingId = BrandedId<"ThingId">;

/** How a thing is formatted: these known values plus any other string. */
export type ThingFormat = "short" | "long" | (string & {});

/**
 * A thing.
 *
 * @pgTable thing
 */
export interface Thing {
    /**
     * The identifier: a filter by default, no @queryFilter needed.
     *
     * @primaryKey
     */
    id: ThingId;
    /**
     * An optional label.
     *
     * @queryOrderBy default asc
     */
    name?: string;
    /**
     * An optional amount.
     *
     * @queryOrderBy
     * @queryWhere gte lte
     */
    amount?: Money;
    /**
     * The revision.
     *
     * @version
     */
    version?: Version;
    /** The format. */
    format?: ThingFormat;
    /**
     * The children.
     *
     * @children
     */
    children?: Child[];
    /**
     * The parent.
     *
     * @relation
     */
    parent?: Parent;
}

/**
 * A child of a thing.
 *
 * @pgTable child
 */
export interface Child {
    /**
     * The child identifier.
     *
     * @primaryKey
     */
    id: ChildId;
    /** The owning thing. */
    thingId: ThingId;
}

export type ChildId = BrandedId<"ChildId">;

/**
 * A parent of a thing.
 *
 * @pgTable parent
 */
export interface Parent {
    /**
     * The parent identifier.
     *
     * @primaryKey
     */
    id: ParentId;
}

export type ParentId = BrandedId<"ParentId">;
`.trim();

/** The Zod surface the stub needs, so the functional tests stay typed. */
interface ZodStub {
    string: () => { optional: () => unknown };
    bigint: () => unknown;
    object: (shape: unknown) => unknown;
    strictObject: (shape: unknown) => unknown;
    literal: (value: unknown) => { optional: () => unknown };
}

function zodStub(): ZodStub {
    const require = createRequire(import.meta.url);
    return (require("zod") as { z: ZodStub }).z;
}

describe("generatePrimitives", () => {
    it("renders a schema per primitive, sorted by name", () => {
        const { files } = generate({ domain: {} });
        const code = files.get("primitives.ts") ?? "";

        expect(code).toContain("export const guidSchema = z.uuid();");
        expect(code).toContain('export const languageSchema = z.enum(["fi", "sv"]).or(z.string());');
    });

    it("renders a factory for a generic primitive, carrying its type parameters", () => {
        const { files } = generate({ domain: {} });
        const code = files.get("primitives.ts") ?? "";

        expect(code).toContain("export function brandedIdSchema<Name extends string>() {");
        expect(code).toContain("return z.uuid().brand<Name>();");
    });

    it("starts with the do-not-edit header", () => {
        const code = generatePrimitives([]);

        expect(code.startsWith("// Generated by scripts/generate-zod-schemas.ts. Do not edit.\n")).toBe(true);
    });

    it("evaluates to working schemas", () => {
        const { files } = generate({ domain: {} });
        const require = createRequire(import.meta.url);
        const code = ts.transpileModule(files.get("primitives.ts") ?? "", {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const exports: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {};
        new Function("exports", "require", code)(exports, require);

        expect(exports.moneySchema?.safeParse("12.50").success).toBe(true);
        expect(exports.moneySchema?.safeParse("not a number").success).toBe(false);
        expect(exports.versionSchema?.safeParse(1n).success).toBe(true);
    });
});

describe("generateDomainEntity", () => {
    it("renders the entity's 1:1 schema, and nothing a write owns", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = domainFile(files, "Thing");

        expect(code).toContain("export const thingSchema = z.object({");
        expect(code).not.toContain("thingPatchSchema");
        expect(code).not.toContain("thingInsertSchema");
    });

    it("references a primitive schema, calling a generic primitive as a factory", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = domainFile(files, "Thing");

        expect(code).toContain('import * as primitives from "../primitives.ts";');
        expect(code).toContain('id: primitives.brandedIdSchema<"ThingId">(),');
        expect(code).toContain("amount: primitives.moneySchema.optional(),");
    });

    it("marks an optional field optional and a required one not", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = domainFile(files, "Thing");

        expect(code).toContain("name: z.string().optional(),");
        expect(code).toContain('id: primitives.brandedIdSchema<"ThingId">(),');
    });

    it("imports referenced entity schemas from the sibling modules in its own directory", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = domainFile(files, "Thing");

        expect(code).toContain('import { childSchema } from "./childSchema.ts";');
        expect(code).toContain('import { parentSchema } from "./parentSchema.ts";');
        expect(code).toContain("children: z.array(z.lazy(() => childSchema)).optional(),");
        expect(code).toContain("parent: z.lazy(() => parentSchema).optional(),");
    });

    it("resolves an open-union alias to an enum plus a string", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = domainFile(files, "Thing");

        expect(code).toContain('format: z.enum(["short", "long"]).or(z.string()).optional(),');
    });

    it("imports no entity type, because it declares no write type", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = domainFile(files, "Thing");

        expect(code).not.toContain("import type {");
    });
});

describe("generateRepositoryEntity", () => {
    it("derives every write schema from the 1:1 schema in the domain module", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const repo = 'import { thingSchema } from "../domain/thingSchema.ts";';

        expect(insertFile(files, "Thing")).toContain(repo);
        expect(upsertFile(files, "Thing")).toContain(repo);
        expect(patchFile(files, "Thing")).toContain(repo);
        expect(primaryKeyFile(files, "Thing")).toContain(repo);
    });

    it("imports the spec entity type for each write type", () => {
        const { files } = generate({ domain: { Thing: THING } });

        expect(insertFile(files, "Thing")).toContain('import type { Thing } from "spec/');
        expect(patchFile(files, "Thing")).toContain('import type { Thing } from "spec/');
        expect(primaryKeyFile(files, "Thing")).toContain('import type { Thing } from "spec/');
    });

    it("requires the key and the version in the patch schema", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = patchFile(files, "Thing");

        expect(code).toContain("every field is optional except the key and the version");
        expect(code).toContain("    .required({\n        id: true,\n        version: true,\n    })");
        expect(code).toContain("    .strict();");
    });

    it("names the omitted fields, the locked ones, and the nullable ones a patch may clear", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = patchFile(files, "Thing");

        expect(code).toContain(
            'export type ThingPatch = Patch<Thing, "children" | "parent", "id" | "version", "name" | "amount" | "format">;',
        );
    });

    it("mirrors the insert schema's omit list in the insert type", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = insertFile(files, "Thing");

        expect(code).toContain('export type ThingInsert = Omit<Thing, "children" | "parent">;');
    });

    it("renders the primary key as a schema and a type over the entity, so a by-key write names only the key", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = primaryKeyFile(files, "Thing");

        expect(code).toContain("export const thingPrimaryKeySchema = thingSchema.pick({ id: true }).strict();");
        expect(code).toContain('export type ThingPrimaryKey = Pick<Thing, "id">;');
    });

    it("requires only the key when the entity has no version", () => {
        const { files } = generate({ domain: { Marker: MARKER } });
        const code = patchFile(files, "Marker");

        expect(code).toContain('export type MarkerPatch = Patch<Marker, "total", "id", "label" | "createdAt">;');
        expect(code).not.toContain('"id" | "version"');
    });

    it("projects a composite key to all of its fields, and requires them all in a patch", () => {
        const { files } = generate({ domain: { Translation: TRANSLATION } });

        expect(primaryKeyFile(files, "Translation")).toContain(
            "export const translationPrimaryKeySchema = translationSchema.pick({ languageCode: true, key: true }).strict();",
        );
        expect(primaryKeyFile(files, "Translation")).toContain(
            'export type TranslationPrimaryKey = Pick<Translation, "languageCode" | "key">;',
        );
        expect(patchFile(files, "Translation")).toContain(
            "        languageCode: true,\n        key: true,\n    })\n    .strict();",
        );
    });

    it("keeps the entity type when the insert schema omits nothing", () => {
        const bare = "export interface Bare {\n    /** @primaryKey */\n    id: BareId; }\nexport type BareId = BrandedId<\"BareId\">;";
        const { files } = generate({ domain: { Bare: bare } });

        expect(insertFile(files, "Bare")).toContain("export type BareInsert = Bare;");
    });

    it("renders no primary key module when the entity declares no key", () => {
        const keyless = "export interface Keyless {\n    label: string; }";
        const { files } = generate({ domain: { Keyless: keyless } });

        expect(files.has(join("repositories", primaryKeyModuleName("Keyless")))).toBe(false);
        expect(files.get(join("repositories", "index.ts"))).not.toContain("keylessPrimaryKeySchema");
    });

    it("keeps the version a create omits, and keeps the create's relaxed fields relaxed", () => {
        const { files } = generate({ domain: { Revision: REVISION } });
        const insert = insertFile(files, "Revision");
        const upsert = upsertFile(files, "Revision");

        // A create leaves the version and the status to their defaults.
        expect(insert).toContain("    .omit({\n        version: true,\n    })");
        expect(insert).toContain('export type RevisionInsert = Omit<Revision, "version" | "status"> & Partial<Pick<Revision, "status">>;');
        // An upsert claims the version, and still lets a caller omit the field the database defaults.
        expect(upsert).not.toContain("        version: true,");
        expect(upsert).toContain("    .partial({\n        status: true,\n    })");
        expect(upsert).toContain('export type RevisionUpsert = Upsert<Revision, never, "id" | "version", never, "status">;');
        expect(upsert).toContain('import type { Upsert } from "../upsert.ts";');
        expect(upsert).toContain("plus the `@version` it claims");
    });

    it("accepts null for a nullable column, as a patch does, and for nothing else", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = upsertFile(files, "Thing");

        // The same nullable set a patch widens, from the same helper.
        expect(code).toContain(
            [
                "    .extend({",
                "        name: thingSchema.shape.name.nullable(),",
                "        amount: thingSchema.shape.amount.nullable(),",
                "        format: thingSchema.shape.format.nullable(),",
                "    })",
            ].join("\n"),
        );
        expect(code).toContain(
            'export type ThingUpsert = Upsert<Thing, "children" | "parent", "id" | "version", "name" | "amount" | "format", never>;',
        );
        // The key and the version are locked, so neither may be cleared.
        expect(code).not.toContain("id: thingSchema.shape.id.nullable()");
        expect(code).not.toContain("version: thingSchema.shape.version.nullable()");
    });

    it("widens an inlined branch where it is extended, so a snapshot can be cleared whole", () => {
        const { files } = generate({ domain: { Thing: INLINED } });
        const code = upsertFile(files, "Thing");

        // `snapshot` is optional, so its column is nullable and the branch takes `null` as a patch does.
        expect(code).toContain("snapshot: childInsertSchema.nullable().optional(),");
        expect(code).toContain('"snapshot"');
        // The widening rides on the branch's own insert schema, not the domain schema it replaced.
        expect(code).not.toContain("snapshot: thingSchema.shape.snapshot.nullable()");
    });

    it("derives every write module from the same entity schema, naming its own const", () => {
        const { files } = generate({ domain: { Thing: THING } });

        expect(upsertFile(files, "Thing")).toContain("export const thingUpsertSchema = thingSchema");
        expect(upsertFile(files, "Thing")).toContain('import type { Thing } from "spec/');
    });
});

describe("generateIndex", () => {
    it("re-exports the primitives and every generated directory", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("index.ts") ?? "";

        expect(code).toContain('export * from "./primitives.ts";');
        expect(code).toContain('export * from "./domain/index.ts";');
        expect(code).toContain('export * from "./repositories/index.ts";');
        expect(code).toContain('export * from "./queries/index.ts";');
    });

    it("re-exports each generated module from its own directory barrel", () => {
        const { files } = generate({ domain: { Thing: THING } });

        expect(files.get(join("domain", "index.ts"))).toContain('export * from "./thingSchema.ts";');
        const repositoryIndex = files.get(join("repositories", "index.ts"));
        expect(repositoryIndex).toContain('export * from "./thingInsertSchema.ts";');
        expect(repositoryIndex).toContain('export * from "./thingUpsertSchema.ts";');
        expect(repositoryIndex).toContain('export * from "./thingPatchSchema.ts";');
        expect(repositoryIndex).toContain('export * from "./thingPrimaryKeySchema.ts";');
    });
});

describe("buildZodModel diagnostics", () => {
    it("reports a field whose type it cannot map", () => {
        const thing = "export interface Thing {\n    /** @primaryKey */\n    id: ThingId; weird: Promise<string>; }\nexport type ThingId = BrandedId<\"ThingId\">;";
        const { diagnostics } = generate({ domain: { Thing: thing } });

        expect(messages(diagnostics)).toEqual(["`weird`: unsupported type `Promise<string>`"]);
    });

    it("renders an entity from a fixture with no diagnostics", () => {
        const { diagnostics } = generate({ domain: { Thing: THING } });

        expect(diagnostics).toEqual([]);
    });
});

describe("generateEntity standalone", () => {
    it("produces the same text as the file set, for every module", () => {
        const { model, files } = generate({ domain: { Thing: THING } });
        const thing = model.entities.find((entity) => entity.name === "Thing");
        const byName = new Map(model.entities.map((entity) => [entity.name, entity]));

        expect(thing && generateDomainEntity(thing, byName)).toBe(domainFile(files, "Thing"));
        expect(thing && generateInsertSchema(thing, byName)).toBe(insertFile(files, "Thing"));
        expect(thing && generateUpsertSchema(thing, byName)).toBe(upsertFile(files, "Thing"));
        expect(thing && generatePatchSchema(thing)).toBe(patchFile(files, "Thing"));
        expect(thing && generatePrimaryKeySchema(thing)).toBe(primaryKeyFile(files, "Thing"));
    });
});

describe("buildZodModel queries", () => {
    it("builds one query per entity, named query<Entity>Schema", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const names = model.queries.map((query) => query.schemaName).sort();

        expect(names).toEqual(["queryChildSchema", "queryParentSchema", "queryThingSchema"]);
    });

    it("records the entity each query queries", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const queryThing = model.queries.find((query) => query.entity === "Thing");

        expect(queryThing?.schemaName).toBe("queryThingSchema");
    });

    it("resolves @queryFilter fields as optional sets", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const queryThing = model.queries.find((query) => query.entity === "Thing");

        expect(queryThing?.fields).toEqual([
            { name: "id", expression: 'z.array(primitives.brandedIdSchema<"ThingId">()).optional()' },
        ]);
        expect(queryThing?.usesPrimitives).toBe(true);
    });

    it("makes every entity's id a filter, with no tag", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const queryChild = model.queries.find((query) => query.entity === "Child");

        expect(queryChild?.fields).toEqual([
            { name: "id", expression: 'z.array(primitives.brandedIdSchema<"ChildId">()).optional()' },
        ]);
    });

    it("records the orderable fields", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const queryThing = model.queries.find((query) => query.entity === "Thing");
        const queryChild = model.queries.find((query) => query.entity === "Child");

        expect(queryThing?.orderFields).toEqual(["name", "amount"]);
        expect(queryChild?.orderFields).toEqual([]);
    });

    it("records the comparable fields with their operators", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const queryThing = model.queries.find((query) => query.entity === "Thing");
        const queryChild = model.queries.find((query) => query.entity === "Child");

        expect(queryThing?.whereFields).toEqual([
            { name: "amount", operators: ["gte", "lte"], expression: "primitives.moneySchema" },
        ]);
        expect(queryChild?.whereFields).toEqual([]);
    });
});

describe("generateQueryFile", () => {
    it("emits the query-specific select schema and query args schema", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "queryThing.ts")) ?? "";

        expect(code).toContain("export const queryThingSelectSchema = z.lazy(() =>");
        expect(code).toContain("        id: z.literal(true).optional(),");
        expect(code).toContain('import { queryChildSelectSchema } from "./queryChild.ts";');
        expect(code).toContain(
            "        children: z.union([z.literal(true), z.lazy(() => queryChildSelectSchema)]).optional(),",
        );
        expect(code).toContain("export const queryThingSchema = z.strictObject({");
        expect(code).toContain("    filter: z.strictObject({");
        expect(code).toContain('        id: z.array(primitives.brandedIdSchema<"ThingId">()).optional(),');
        expect(code).toContain("    }).optional(),");
        expect(code).toContain("    order: z.array(");
        expect(code).toContain('        z.tuple([z.enum(["name", "amount"]), z.enum(["asc", "desc"])]),');
        expect(code).toContain("    where: z.strictObject({");
        expect(code).toContain("        amount: z.strictObject({");
        expect(code).toContain("            gte: primitives.moneySchema.optional(),");
        expect(code).toContain("            lte: primitives.moneySchema.optional(),");
        expect(code).toContain("    limit: z.number().int().positive().optional(),");
        expect(code).toContain("    offset: z.number().int().nonnegative().optional(),");
        expect(code).toContain("    select: queryThingSelectSchema,");
    });

    it("emits only the query schema", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "queryThing.ts")) ?? "";

        expect(code).toContain("export const queryThingSchema = z.strictObject({");
        expect(code).not.toContain("getThingSchema");
    });

    it("imports the primitives module it references", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "queryThing.ts")) ?? "";

        expect(code).toContain('import * as primitives from "../primitives.ts";');
    });

    it("re-exports every query file from a barrel", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "index.ts")) ?? "";

        expect(code).toContain('export * from "./queryThing.ts";');
    });

    it("re-exports the queries barrel from the root index", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("index.ts") ?? "";

        expect(code).toContain('export * from "./queries/index.ts";');
    });

    it("evaluates to a working args schema", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const byName = new Map(model.entities.map((entity) => [entity.name, entity]));
        const queries = model.queries.filter((query) => query.entity === "Thing");
        const code = generateQueryFile("Thing", queries, byName);
        const require = createRequire(import.meta.url);
        const z = zodStub();
        const exportedCode = ts.transpileModule(code, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const exports: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {};
        const stubRequire = (id: string) => {
            if (id === "zod") {
                return { z };
            }
            if (id === "../primitives.ts") {
                return { brandedIdSchema: () => z.string(), moneySchema: z.string() };
            }
            if (id === "./queryChild.ts") {
                return { queryChildSelectSchema: z.strictObject({}) };
            }
            if (id === "./queryParent.ts") {
                return { queryParentSelectSchema: z.strictObject({}) };
            }
            return require(id);
        };
        new Function("exports", "require", exportedCode)(exports, stubRequire);

        expect(exports.queryThingSchema?.safeParse({ select: {} }).success).toBe(true);
        expect(exports.queryThingSchema?.safeParse({ filter: { id: ["x"] }, select: {} }).success).toBe(true);
        // A flat filter field and a non-array value are both rejected by the nested strict object.
        expect(exports.queryThingSchema?.safeParse({ id: ["x"], select: {} }).success).toBe(false);
        expect(exports.queryThingSchema?.safeParse({ filter: { id: "x" }, select: {} }).success).toBe(false);
        expect(exports.queryThingSchema?.safeParse({ order: [["name", "asc"]], select: {} }).success).toBe(true);
        expect(exports.queryThingSchema?.safeParse({ order: [["amount", "desc"]], select: {} }).success).toBe(true);
        // An unknown field and an unknown direction are both rejected before they reach SQL.
        expect(exports.queryThingSchema?.safeParse({ order: [["nope", "asc"]], select: {} }).success).toBe(false);
        expect(exports.queryThingSchema?.safeParse({ order: [["name", "up"]], select: {} }).success).toBe(false);
        // The direction is required, so a one-element clause is rejected.
        expect(exports.queryThingSchema?.safeParse({ order: [["name"]], select: {} }).success).toBe(false);
        // Paging is bounded before it reaches the SQL.
        expect(exports.queryThingSchema?.safeParse({ limit: 10, offset: 5, select: {} }).success).toBe(true);
        expect(exports.queryThingSchema?.safeParse({ limit: 0, select: {} }).success).toBe(false);
        expect(exports.queryThingSchema?.safeParse({ offset: -1, select: {} }).success).toBe(false);
        expect(exports.queryThingSchema?.safeParse({ limit: 1.5, select: {} }).success).toBe(false);
        // Comparisons are whitelisted by field and operator, so a stray one is a 400.
        expect(exports.queryThingSchema?.safeParse({ where: { amount: { gte: "1" } }, select: {} }).success).toBe(
            true,
        );
        expect(exports.queryThingSchema?.safeParse({ where: { amount: { gt: "1" } }, select: {} }).success).toBe(
            false,
        );
        expect(exports.queryThingSchema?.safeParse({ where: { name: { eq: "x" } }, select: {} }).success).toBe(false);
    });
});

describe("select schemas", () => {
    /** Transpile a query module and run it, stubbing the modules it imports. */
    function loadQuery(fileName: string): Record<string, { safeParse: (value: unknown) => { success: boolean } }> {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(fileName) ?? "";
        const require = createRequire(import.meta.url);
        const z = zodStub();
        const scalar = z.string();
        const stubRequire = (id: string) => {
            if (id === "zod") {
                return { z };
            }
            if (id === "../primitives.ts") {
                return {
                    brandedIdSchema: () => scalar,
                    moneySchema: scalar,
                };
            }
            if (id === "./primitives.ts") {
                return {
                    brandedIdSchema: () => scalar,
                    moneySchema: scalar,
                    versionSchema: z.bigint(),
                    languageSchema: scalar,
                };
            }
            if (id === "./queryChild.ts" || id === "./queryParent.ts") {
                return {
                    queryChildSelectSchema: z.strictObject({ id: z.literal(true).optional() }),
                    queryParentSelectSchema: z.strictObject({ id: z.literal(true).optional() }),
                };
            }
            return require(id);
        };
        const exportedCode = ts.transpileModule(code, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const exports: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {};
        new Function("exports", "require", exportedCode)(exports, stubRequire);
        return exports;
    }

    it("accepts `true` on a scalar field", () => {
        const exports = loadQuery(join("queries", "queryThing.ts"));

        expect(exports.queryThingSelectSchema?.safeParse({ name: true }).success).toBe(true);
    });

    it("rejects an unknown field", () => {
        const exports = loadQuery(join("queries", "queryThing.ts"));

        expect(exports.queryThingSelectSchema?.safeParse({ nope: true }).success).toBe(false);
    });

    it("accepts `true` on a branch, meaning its scalars", () => {
        const exports = loadQuery(join("queries", "queryThing.ts"));

        expect(exports.queryThingSelectSchema?.safeParse({ parent: true }).success).toBe(true);
        expect(exports.queryThingSelectSchema?.safeParse({ children: true }).success).toBe(true);
    });

    it("rejects a non-object on a branch", () => {
        const exports = loadQuery(join("queries", "queryThing.ts"));

        expect(exports.queryThingSelectSchema?.safeParse({ parent: 5 }).success).toBe(false);
    });

    it("validates an entity with no branches", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "queryChild.ts")) ?? "";

        expect(code).toContain("export const queryChildSelectSchema = z.lazy(() =>");
        expect(code).toContain("        thingId: z.literal(true).optional(),");
    });
});

/** A column the database defaults, one it derives, and one the insert must carry. */
/** An entity whose version the database owns: the one field a create omits and an upsert claims. */
const REVISION = `
import type { BrandedId } from "./primitives.ts";

/** The identifier of a revision. */
export type RevisionId = BrandedId<"RevisionId">;

/**
 * A revision.
 *
 * @pgTable revision
 */
export interface Revision {
    /**
     * The identifier.
     *
     * @primaryKey
     */
    id: RevisionId;
    /**
     * The status, which the database fills when a caller leaves it out.
     *
     * @pgDefault 'pending'
     */
    status: string;
    /**
     * The revision.
     *
     * @version
     * @pgDefault 0
     */
    version: Version;
}
`.trim();

const MARKER = `
import type { BrandedId } from "./primitives.ts";

/** The identifier of a marker. */
export type MarkerId = BrandedId<"MarkerId">;

/**
 * A marker.
 *
 * @pgTable marker
 */
export interface Marker {
    /**
     * The identifier.
     *
     * @primaryKey
     */
    id: MarkerId;
    /** A label the caller supplies. */
    label?: string;
    /**
     * When it was created.
     *
     * @pgDefault now()
     */
    createdAt?: Date;
    /**
     * A total the trigger derives.
     *
     * @computed
     * @pgTrigger NEW."total" := NEW."label"
     */
    total?: Money;
    /**
     * A stored value the insert has to carry.
     *
     * @computed
     * @pgTrigger NEW."required" := NEW."label"
     */
    required: Money;
}
`.trim();

/** A composite primary key: several @primaryKey fields, ordered by declaration. */
const TRANSLATION = `
/**
 * A translation entry.
 *
 * @pgTable translation
 */
export interface Translation {
    /**
     * The language code.
     *
     * @primaryKey
     */
    languageCode: string;
    /**
     * The key.
     *
     * @primaryKey
     */
    key: string;
    /** The translated value. */
    value?: string;
}
`.trim();

/** An `@inlined` branch, which a create writes as a nested object rather than a column. */
const INLINED = `
import type { BrandedId } from "./primitives.ts";

/** The identifier of a thing. */
export type ThingId = BrandedId<"ThingId">;

/** The identifier of a child. */
export type ChildId = BrandedId<"ChildId">;

/**
 * A child.
 *
 * @pgTable child
 */
export interface Child {
    /**
     * The child identifier.
     *
     * @primaryKey
     */
    id: ChildId;
    /** A name. */
    name?: string;
}

/**
 * A thing holding a snapshot of its child.
 *
 * @pgTable thing
 */
export interface Thing {
    /**
     * The identifier.
     *
     * @primaryKey
     */
    id: ThingId;
    /**
     * The child as it was.
     *
     * @inlined
     */
    snapshot?: Child;
}
`.trim();

describe("insert schemas", () => {
    it("omits the branches a create cannot write", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = insertFile(files, "Thing");

        expect(code).toContain("export const thingInsertSchema = thingSchema");
        expect(code).toContain("        children: true,");
        expect(code).toContain("        parent: true,");
        expect(code).toContain("    .strict();");
    });

    it("omits a derivable column, keeps a required one, and leaves a defaulted one omittable", () => {
        const { files } = generate({ domain: { Marker: MARKER } });
        const code = insertFile(files, "Marker");

        expect(code).toContain("        total: true,");
        expect(code).toContain('export type MarkerInsert = Omit<Marker, "total">;');
        expect(code).not.toContain("        required: true,");
        expect(code).not.toContain("        label: true,");
    });

    it("relaxes a required defaulted column, which a create may omit", () => {
        const entity = `
import type { BrandedId } from "./primitives.ts";

/** The identifier of a thing. */
export type ThingId = BrandedId<"ThingId">;

/** A thing. */
export interface Thing {
    /**
     * The identifier.
     *
     * @primaryKey
     */
    id: ThingId;
    /**
     * Where it came from.
     *
     * @pgDefault 'manual'
     */
    source: string;
}
`.trim();
        const { files } = generate({ domain: { Thing: entity } });
        const code = insertFile(files, "Thing");

        expect(code).toContain("    .partial({\n        source: true,\n    })");
        expect(code).toContain('export type ThingInsert = Omit<Thing, "source"> & Partial<Pick<Thing, "source">>;');
    });

    it("nests an `@inlined` branch as the target's insert schema", () => {
        const { files } = generate({ domain: { Thing: INLINED } });
        const code = insertFile(files, "Thing");

        expect(code).toContain('import { childInsertSchema } from "./childInsertSchema.ts";');
        expect(code).toContain("        snapshot: childInsertSchema.optional(),");
        expect(code).not.toContain("        snapshot: true,");
    });
});

describe("patch schemas", () => {
    it("omits the same fields a create does, so a patch cannot send them", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = patchFile(files, "Thing");

        expect(code).toContain("export const thingPatchSchema = thingSchema");
        expect(code).toContain("        children: true,");
        expect(code).toContain("        parent: true,");
        expect(code).toContain("    .partial()");
    });

    it("keeps the version a create omits, since a patch must carry it", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = patchFile(files, "Thing");

        expect(code).toContain(
            [
                "export const thingPatchSchema = thingSchema",
                "    .omit({",
                "        children: true,",
                "        parent: true,",
                "    })",
                "    .partial()",
                "    .extend({",
                "        name: thingSchema.shape.name.nullable(),",
                "        amount: thingSchema.shape.amount.nullable(),",
                "        format: thingSchema.shape.format.nullable(),",
                "    })",
                "    .required({",
                "        id: true,",
                "        version: true,",
                "    })",
                "    .strict();",
            ].join("\n"),
        );
    });

    it("leaves a required field with no nullable shape to extend", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = patchFile(files, "Child");

        expect(code).not.toContain(".extend({");
    });
    it("requires only the key when the entity has no version", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = patchFile(files, "Child");

        expect(code).toContain("    .required({\n        id: true,\n    })");
        expect(code).not.toContain("version");
    });

    it("rejects a field the update would never write, and keeps a defaulted one writable", () => {
        const { files } = generate({ domain: { Marker: MARKER } });
        const code = patchFile(files, "Marker");

        expect(code).toContain("        total: true,");
        expect(code).not.toContain("        createdAt: true,");
        expect(code).not.toContain("        required: true,");
    });
});

/** An entity with one nullable column, one defaulted column, and a version, for the upsert checks. */
const NOTE = `
import type { BrandedId } from "./primitives.ts";

/** The identifier of a note. */
export type NoteId = BrandedId<"NoteId">;

/**
 * A note.
 *
 * @pgTable note
 */
export interface Note {
    /**
     * The identifier.
     *
     * @primaryKey
     */
    id: NoteId;
    /** Free-form text, which a caller may clear. */
    text?: string;
    /**
     * The status, which the database fills when a caller leaves it out.
     *
     * @pgDefault 'pending'
     */
    status: string;
    /**
     * The revision.
     *
     * @version
     * @pgDefault 0
     */
    version: Version;
}
`.trim();

describe("upsert schemas", () => {
    /** The evaluated `noteUpsertSchema`, built over a stub domain module the fixture would import. */
    function noteUpsert() {
        const { files } = generate({ domain: { Note: NOTE } });
        const code = upsertFile(files, "Note");
        const require = createRequire(import.meta.url);
        const z = zodStub();
        const exportedCode = ts.transpileModule(code, {
            compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
        }).outputText;
        const exports: Record<string, { safeParse: (value: unknown) => { success: boolean } }> = {};
        const stubRequire = (id: string) => {
            if (id === "zod") {
                return { z };
            }
            if (id === "../domain/noteSchema.ts") {
                return {
                    noteSchema: z.strictObject({
                        id: z.string(),
                        text: z.string().optional(),
                        status: z.string(),
                        version: z.bigint(),
                    }),
                };
            }
            return require(id);
        };
        new Function("exports", "require", exportedCode)(exports, stubRequire);
        return exports.noteUpsertSchema;
    }

    it("clears a nullable column with null, exactly as a patch does", () => {
        expect(noteUpsert()?.safeParse({ id: "n1", version: 0n, text: null }).success).toBe(true);
    });

    it("still accepts the column omitted, since an upsert writes every column it names", () => {
        expect(noteUpsert()?.safeParse({ id: "n1", version: 0n }).success).toBe(true);
        expect(noteUpsert()?.safeParse({ id: "n1", version: 0n, text: "kept" }).success).toBe(true);
    });

    it("refuses null for the key, the version, and a column that cannot hold one", () => {
        // The key and the version are locked, so neither can be cleared.
        expect(noteUpsert()?.safeParse({ id: null, version: 0n }).success).toBe(false);
        expect(noteUpsert()?.safeParse({ id: "n1", version: null }).success).toBe(false);
        // `status` is required with a default, so it is relaxed but not nullable.
        expect(noteUpsert()?.safeParse({ id: "n1", version: 0n, status: null }).success).toBe(false);
    });

    it("still requires the version a create omits", () => {
        expect(noteUpsert()?.safeParse({ id: "n1", text: null }).success).toBe(false);
    });

    it("rejects a field the statement would never write", () => {
        expect(noteUpsert()?.safeParse({ id: "n1", version: 0n, extra: 1 }).success).toBe(false);
    });
});
