/** Unit tests for the `effect/schema` generator, driven by self-contained fixtures. */
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Project, ts } from "ts-morph";
import { Schema } from "effect";
import { buildSchemaModel, type Diagnostic } from "./schema-model.ts";
import { generateEntity, generatePrimitives, generateQueryFile, generateSchemas } from "./generate-schemas.ts";

const SPEC_GLOB = "fixtures/domain/**/*.ts";

/** A schema the generated modules can be evaluated against, structurally. */
type AnySchema = Parameters<typeof Schema.decodeUnknownResult>[0];

interface Fixture {
    domain: Record<string, string>;
}

/** Primitive aliases a fixture field can reference, each declaring its own `effect/schema`. */
const PRIMITIVES = `
/**
 * @primitive
 * @pgtype uuid
 * @effect Schema.String.check(Schema.isUUID())
 */
export type GUID = string;

/**
 * @primitive
 * @pgtype uuid
 * @effect Schema.String.check(Schema.isUUID()).pipe(Schema.brand<Name>(name as never))
 */
export type BrandedId<Name extends string> = GUID & Brand.Brand<Name>;

/**
 * @primitive
 * @pgtype decimal
 * @effect Schema.String.check(Schema.isPattern(/^-?\\d+(\\.\\d+)?$/)).pipe(Schema.brand("Money"))
 */
export type Money = string;

/**
 * @primitive
 * @pgtype text
 * @effect Schema.Union([Schema.Literals(["fi", "sv"]), Schema.String])
 */
export type Language = "fi" | "sv" | (string & {});

/**
 * @primitive
 * @pgtype int8
 * @effect Schema.BigInt.pipe(Schema.brand("Version"))
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
    const model = buildSchemaModel(project, { specGlob: SPEC_GLOB, aliasGlob: SPEC_GLOB });
    return { model, files: generateSchemas(model), diagnostics: model.diagnostics };
}

function messages(diagnostics: Diagnostic[]): string[] {
    return diagnostics.map((diagnostic) => diagnostic.message);
}

/** Transpile a generated module to CommonJS and evaluate it, resolving imports through `stubs`. */
function evaluate(code: string, stubs: Record<string, unknown>): Record<string, unknown> {
    const require = createRequire(import.meta.url);
    const compiled = ts.transpileModule(code, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const exports: Record<string, unknown> = {};
    const stubRequire = (id: string) => (id in stubs ? stubs[id] : require(id));
    new Function("exports", "require", compiled)(exports, stubRequire);
    return exports;
}

/** True when `value` decodes against `schema`; strictness is a decode-site option. */
function accepts(schema: unknown, value: unknown, options?: { onExcessProperty: "error" }): boolean {
    const result = Schema.decodeUnknownResult(schema as AnySchema)(value, options);
    return result._tag === "Success";
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
 * @table thing
 */
export interface Thing {
    /** The identifier: a filter by default, no @queryfilter needed. */
    id: ThingId;
    /** An optional label. */
    name?: string;
    /** An optional amount. */
    amount?: Money;
    /**
     * The revision.
     *
     * @version
     */
    version?: Version;
    /** The format. */
    format?: ThingFormat;
    /** The children. */
    children?: Child[];
    /** The parent. */
    parent?: Parent;
}

/**
 * A child of a thing.
 *
 * @table child
 */
export interface Child {
    /** The child identifier. */
    id: ChildId;
    /** The owning thing. */
    thingId: ThingId;
}

export type ChildId = BrandedId<"ChildId">;

/**
 * A parent of a thing.
 *
 * @table parent
 */
export interface Parent {
    /** The parent identifier. */
    id: ParentId;
}

export type ParentId = BrandedId<"ParentId">;
`.trim();

const UUID = "123e4567-e89b-42d3-a456-426614174000";

/** The runtime stubs a generated entity module needs: primitives plus the entities it imports. */
function entityStubs(): Record<string, unknown> {
    const scalarId = Schema.String.check(Schema.isUUID());
    return {
        effect: { Schema },
        "./primitives.ts": {
            brandedIdSchema: () => scalarId,
            moneySchema: Schema.String.check(Schema.isPattern(/^-?\d+(\.\d+)?$/)),
            versionSchema: Schema.BigInt,
            languageSchema: Schema.Union([Schema.Literals(["short", "long"]), Schema.String]),
        },
        "./child.ts": {
            childSchema: Schema.Struct({ id: scalarId, thingId: scalarId }),
            childSelectSchema: Schema.Struct({ id: Schema.optionalKey(Schema.Literal(true)) }),
        },
        "./parent.ts": {
            parentSchema: Schema.Struct({ id: scalarId }),
            parentSelectSchema: Schema.Struct({ id: Schema.optionalKey(Schema.Literal(true)) }),
        },
    };
}

describe("generatePrimitives", () => {
    it("renders a schema per primitive, sorted by name", () => {
        const { files } = generate({ domain: {} });
        const code = files.get("primitives.ts") ?? "";

        expect(code).toContain("export const guidSchema = Schema.String.check(Schema.isUUID());");
        expect(code).toContain(
            'export const languageSchema = Schema.Union([Schema.Literals(["fi", "sv"]), Schema.String]);',
        );
    });

    it("renders a factory for a generic primitive, carrying its type parameters", () => {
        const { files } = generate({ domain: {} });
        const code = files.get("primitives.ts") ?? "";

        expect(code).toContain("export function brandedIdSchema<Name extends string>(name: Name) {");
        expect(code).toContain("return Schema.String.check(Schema.isUUID()).pipe(Schema.brand<Name>(name as never));");
    });

    it("imports Schema from effect and starts with the do-not-edit header", () => {
        const code = generatePrimitives([]);

        expect(code.startsWith("// Generated by scripts/generate-schemas.ts. Do not edit.\n")).toBe(true);
        expect(code).toContain('import { Schema } from "effect";');
    });

    it("evaluates to working schemas", () => {
        const { files } = generate({ domain: {} });
        const exports = evaluate(files.get("primitives.ts") ?? "", { effect: { Schema } });

        expect(accepts(exports.moneySchema, "12.50")).toBe(true);
        expect(accepts(exports.moneySchema, "not a number")).toBe(false);
        expect(accepts(exports.versionSchema, 1n)).toBe(true);
        expect(accepts(exports.guidSchema, UUID)).toBe(true);
        expect(accepts(exports.guidSchema, "nope")).toBe(false);
    });
});

describe("generateEntity", () => {
    it("names the schema, the patch schema, and the select schema after the entity", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain("export const thingSchema = Schema.Struct({");
        expect(code).toContain("export const thingPatchSchema = Schema.Struct({");
        expect(code).toContain("export const thingSelectSchema = Schema.suspend(() =>");
    });

    it("references a primitive schema, calling a generic primitive as a factory", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain('import * as primitives from "./primitives.ts";');
        expect(code).toContain('id: primitives.brandedIdSchema("ThingId"),');
        expect(code).toContain("amount: Schema.optionalKey(primitives.moneySchema),");
    });

    it("wraps an optional field in optionalKey and leaves a required one bare", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain("name: Schema.optionalKey(Schema.String),");
        expect(code).toContain('id: primitives.brandedIdSchema("ThingId"),');
    });

    it("imports a referenced entity and references it lazily", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain('import { childSchema, childSelectSchema } from "./child.ts";');
        expect(code).toContain('import { parentSchema, parentSelectSchema } from "./parent.ts";');
        expect(code).toContain("children: Schema.optionalKey(Schema.Array(Schema.suspend(() => childSchema))),");
        expect(code).toContain("parent: Schema.optionalKey(Schema.suspend(() => parentSchema)),");
    });

    it("requires the key and the version in the patch schema", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain("every field is optional except the key and the version");
        expect(code).toContain("    id: primitives.brandedIdSchema(\"ThingId\"),");
        expect(code).toContain("    version: primitives.versionSchema,");
        expect(code).toContain("    name: Schema.optionalKey(Schema.String),");
    });

    it("resolves an open-union alias to a union of literals and a string", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain(
            'format: Schema.optionalKey(Schema.Union([Schema.Literals(["short", "long"]), Schema.String])),',
        );
    });

    it("does not import the entity from its own module", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).not.toContain('from "./thing.ts"');
    });

    it("emits a select schema that takes `true` for a scalar", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain("        id: Schema.optionalKey(Schema.Literal(true)),");
        expect(code).toContain("        name: Schema.optionalKey(Schema.Literal(true)),");
    });

    it("emits a select schema that nests a branch, with `true` allowed", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("thing.ts") ?? "";

        expect(code).toContain(
            "        parent: Schema.optionalKey(Schema.Union([Schema.Literal(true), Schema.suspend(() => parentSelectSchema)])),",
        );
        expect(code).toContain(
            "        children: Schema.optionalKey(Schema.Union([Schema.Literal(true), Schema.suspend(() => childSelectSchema)])),",
        );
    });

    it("evaluates to a working entity schema", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const exports = evaluate(files.get("thing.ts") ?? "", entityStubs());

        expect(accepts(exports.thingSchema, { id: UUID })).toBe(true);
        expect(accepts(exports.thingSchema, { id: UUID, amount: "10.00" })).toBe(true);
        expect(accepts(exports.thingSchema, { id: "not-a-uuid" })).toBe(false);
        expect(accepts(exports.thingSchema, { id: UUID, amount: "free" })).toBe(false);
        expect(accepts(exports.thingSchema, {})).toBe(false);
        // The patch requires the key and the version.
        expect(accepts(exports.thingPatchSchema, { id: UUID, version: 1n })).toBe(true);
        expect(accepts(exports.thingPatchSchema, { id: UUID })).toBe(false);
    });
});

describe("generateIndex", () => {
    it("re-exports the primitives and every entity module", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("index.ts") ?? "";

        expect(code).toContain('export * from "./primitives.ts";');
        expect(code).toContain('export * from "./child.ts";');
        expect(code).toContain('export * from "./thing.ts";');
    });
});

describe("buildSchemaModel diagnostics", () => {
    it("reports a field whose type it cannot map", () => {
        const thing = "export interface Thing { id: ThingId; weird: Promise<string>; }\nexport type ThingId = BrandedId<\"ThingId\">;";
        const { diagnostics } = generate({ domain: { Thing: thing } });

        expect(messages(diagnostics)).toEqual(["`weird`: unsupported type `Promise<string>`"]);
    });

    it("renders an entity from a fixture with no diagnostics", () => {
        const { diagnostics } = generate({ domain: { Thing: THING } });

        expect(diagnostics).toEqual([]);
    });
});

describe("generateEntity standalone", () => {
    it("produces the same text as the file set", () => {
        const { model, files } = generate({ domain: { Thing: THING } });
        const thing = model.entities.find((entity) => entity.name === "Thing");
        const byName = new Map(model.entities.map((entity) => [entity.name, entity]));

        expect(thing && generateEntity(thing, byName)).toBe(files.get("thing.ts"));
    });
});

describe("buildSchemaModel queries", () => {
    it("builds one query per entity, named list<Entity>Schema", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const names = model.queries.map((query) => query.schemaName).sort();

        expect(names).toEqual(["listChildSchema", "listParentSchema", "listThingSchema"]);
    });

    it("records the entity each query lists", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const listThing = model.queries.find((query) => query.entity === "Thing");

        expect(listThing?.schemaName).toBe("listThingSchema");
    });

    it("resolves @queryfilter fields as optional sets", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const listThing = model.queries.find((query) => query.entity === "Thing");

        expect(listThing?.fields).toEqual([
            {
                name: "id",
                expression: 'Schema.Array(primitives.brandedIdSchema("ThingId"))',
                optional: true,
            },
        ]);
        expect(listThing?.usesPrimitives).toBe(true);
    });

    it("makes every entity's id a filter, with no tag", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const listChild = model.queries.find((query) => query.entity === "Child");

        expect(listChild?.fields).toEqual([
            {
                name: "id",
                expression: 'Schema.Array(primitives.brandedIdSchema("ChildId"))',
                optional: true,
            },
        ]);
    });
});

describe("generateQueryFile", () => {
    it("emits the entity's list schema with `select` added", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "thingQueries.ts")) ?? "";

        expect(code).toContain("export const listThingSchema = Schema.Struct({");
        expect(code).toContain('    id: Schema.optionalKey(Schema.Array(primitives.brandedIdSchema("ThingId"))),');
        expect(code).toContain("    select: thingSelectSchema,");
        expect(code).toContain('import { thingSelectSchema } from "../thing.ts";');
    });

    it("emits a get schema that requires at least one filter", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "thingQueries.ts")) ?? "";

        expect(code).toContain("export const getThingSchema = listThingSchema.pipe(");
        expect(code).toContain("    Schema.check(");
        expect(code).toContain(
            '        Schema.makeFilter((value) => value.id !== undefined, { message: "getThing needs at least one filter" }),',
        );
    });

    it("emits no get schema for a query with no filter", () => {
        const { model } = generate({ domain: { Thing: THING } });
        const byName = new Map(model.entities.map((entity) => [entity.name, entity]));
        // A spec entity always has an `id` filter, so an empty query is built by hand.
        const code = generateQueryFile(
            "Thing",
            [{ entity: "Thing", schemaName: "listThingSchema", fields: [], dependencies: [], usesPrimitives: false }],
            byName,
        );

        expect(code).toContain("export const listThingSchema = Schema.Struct({");
        expect(code).not.toContain("getThingSchema");
    });

    it("imports the primitives module it references", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "thingQueries.ts")) ?? "";

        expect(code).toContain('import * as primitives from "../primitives.ts";');
    });

    it("re-exports every query file from a barrel", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get(join("queries", "index.ts")) ?? "";

        expect(code).toContain('export * from "./thingQueries.ts";');
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
        const scalarId = Schema.String.check(Schema.isUUID());
        const exports = evaluate(code, {
            effect: { Schema },
            "../primitives.ts": { brandedIdSchema: () => scalarId },
            "../thing.ts": { thingSelectSchema: Schema.Struct({}) },
        });

        expect(accepts(exports.listThingSchema, { select: {} })).toBe(true);
        expect(accepts(exports.listThingSchema, { id: [UUID], select: {} })).toBe(true);
        expect(accepts(exports.listThingSchema, { id: [UUID] })).toBe(false);
        expect(accepts(exports.getThingSchema, { id: [UUID], select: {} })).toBe(true);
        expect(accepts(exports.getThingSchema, { select: {} })).toBe(false);
        expect(accepts(exports.getThingSchema, { id: UUID, select: {} })).toBe(false);
    });
});

describe("select schemas", () => {
    /** Evaluate an entity module so its `select` schema can be exercised. */
    function loadEntity(fileName: string): Record<string, unknown> {
        const { files } = generate({ domain: { Thing: THING } });
        return evaluate(files.get(fileName) ?? "", entityStubs());
    }

    it("accepts `true` on a scalar field", () => {
        const exports = loadEntity("thing.ts");

        expect(accepts(exports.thingSelectSchema, { name: true })).toBe(true);
    });

    it("ignores an unknown field by default and rejects it when strict", () => {
        const exports = loadEntity("thing.ts");

        expect(accepts(exports.thingSelectSchema, { nope: true })).toBe(true);
        expect(accepts(exports.thingSelectSchema, { nope: true }, { onExcessProperty: "error" })).toBe(false);
    });

    it("accepts `true` on a branch, meaning its scalars", () => {
        const exports = loadEntity("thing.ts");

        expect(accepts(exports.thingSelectSchema, { parent: true })).toBe(true);
        expect(accepts(exports.thingSelectSchema, { children: true })).toBe(true);
    });

    it("rejects a non-object on a branch", () => {
        const exports = loadEntity("thing.ts");

        expect(accepts(exports.thingSelectSchema, { parent: 5 })).toBe(false);
    });

    it("validates an entity with no branches", () => {
        const { files } = generate({ domain: { Thing: THING } });
        const code = files.get("child.ts") ?? "";

        expect(code).toContain("export const childSelectSchema = Schema.suspend(() =>");
        expect(code).toContain("        thingId: Schema.optionalKey(Schema.Literal(true)),");
    });
});
