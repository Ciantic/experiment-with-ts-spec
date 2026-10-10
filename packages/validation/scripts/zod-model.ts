/**
 * Map the parsed spec to the Zod schema model the generator renders.
 * The parsing lives in `spec/scripts/spec-model.ts`; this file adds the Zod mapping.
 * See docs/validation.md.
 */
import {
    autoIncrementProperties,
    defaultedInsertProperties,
    inlinedFromInsert,
    isCompareOperator,
    lowerFirst,
    nullablePatchProperties,
    omittedFromInsert,
    omittedFromPatch,
    primaryKeyProperties,
    type Diagnostic,
    type SpecInterface,
    type SpecLocation,
    type SpecModel,
    type SpecType,
    type SpecTypeAlias,
    type SpecTypeMember,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

export { lowerFirst };

/** One field of an entity schema: the name it is written under and the Zod expression that validates it. */
export interface ZodField {
    name: string;
    expression: string;
}

/** An entity rendered as a `<name>Schema` plus a `<name>PatchSchema`. */
export interface ZodEntity {
    name: string;
    schemaName: string;
    patchName: string;
    /** The schema validating a `select` over this entity's query. See docs/queries.md. */
    querySelectName: string;
    /** The schema validating a create: the entity minus everything the database owns. */
    insertName: string;
    /** The schema validating a by-key write: the entity projected to its `@primaryKey`. */
    primaryKeyName: string;
    /** The schema validating an upsert: what a create carries, plus the `@version` it claims. */
    upsertName: string;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.ts`. */
    importSpecifier: string;
    fields: ZodField[];
    /** Field names a create omits, rendered as an `.omit()` of the entity schema. */
    insertOmit: string[];
    /** Required insertable field names a create may omit, because the column's `@pgDefault` fills them. */
    insertOptional: string[];
    /** Field names a patch omits: the same set, less the key and version a patch must carry. */
    patchOmit: string[];
    /** `@inlined` branches a create nests, each as the target's own insert schema. */
    insertInlined: { name: string; target: string }[];
    /** Entity names a field references, so the file imports their schemas. */
    dependencies: string[];
    /** True when a field resolves through a primitive schema. */
    usesPrimitives: boolean;
    /** Fields the patch schema requires: the key, and every `@version` field. */
    required: string[];
    /** Writable field names whose column is nullable, so a write may widen one to accept `null`. */
    patchNullable: string[];
    /** The `@primaryKey` field names, in declaration order, so a patch's mandatory fields can name them. */
    keys: string[];
    /** The `@version` field names, which an upsert claims and a create never carries. */
    versionFields: string[];
    /** The `@pgAutoIncrement` field names, which an upsert claims and a create leaves to the database. */
    autoIncrementFields: string[];
    /** Every field, classified for `select`: a scalar takes `true`, a branch nests. */
    selectFields: ZodSelectField[];
}

/** One field of a `select`, mirroring `Selection` in `../src/selection.ts`. */
export interface ZodSelectField {
    name: string;
    /** The entity a branch selects into; undefined for a scalar field. */
    target?: string;
}

/** A primitive alias rendered as a schema, or a factory when the alias is generic. */
export interface ZodPrimitive {
    name: string;
    schemaName: string;
    /** The declared type parameters, e.g. `Name extends string`; empty for a plain alias. */
    typeParameters: string;
    /** The `@zod` expression, written verbatim. */
    expression: string;
}

/** The parsed spec, mapped to Zod schemas. */
export interface ZodModel {
    primitives: ZodPrimitive[];
    entities: ZodEntity[];
    queries: ZodQuery[];
    diagnostics: Diagnostic[];
}

/** One comparable field: its name, its whitelisted operators, and the schema its values validate against. */
export interface ZodWhereField {
    name: string;
    operators: string[];
    expression: string;
}

/** The generated `query` schema for one entity: its `@queryFilter` sets plus `select`. */
export interface ZodQuery {
    /** The entity the read queries, which groups the generated file and supplies `select`. */
    entity: string;
    schemaName: string;
    /** The filter fields, all optional sets; the renderer adds the entity's select schema. */
    fields: ZodField[];
    /** The orderable field names, from `@queryOrderBy`; the renderer validates `order` against them. */
    orderFields: string[];
    /** The comparable fields, from `@queryWhere`; the renderer validates `where` against them. */
    whereFields: ZodWhereField[];
    /** Entity names the filters reference, so the file imports their schemas. */
    dependencies: string[];
    /** True when a filter resolves through a primitive schema. */
    usesPrimitives: boolean;
}

/** TypeScript keywords to the Zod schema that validates them. */
const KEYWORD_SCHEMAS: Record<string, string> = {
    string: "z.string()",
    number: "z.number()",
    boolean: "z.boolean()",
    bigint: "z.bigint()",
    symbol: "z.symbol()",
    any: "z.any()",
    unknown: "z.unknown()",
    never: "z.never()",
    void: "z.void()",
    undefined: "z.undefined()",
    null: "z.null()",
    object: "z.object({})",
};

/** Built-in reference types to their Zod schema. Only the ones the spec uses. */
const BUILTIN_REFERENCES: Record<string, string> = {
    Date: "z.date()",
};

/** Invoice -> invoiceSchema. */
function schemaName(name: string): string {
    return `${lowerFirst(name)}Schema`;
}

/** Invoice -> queryInvoiceSelectSchema. */
export function querySelectSchemaName(name: string): string {
    return `query${name}SelectSchema`;
}

/** Invoice -> invoiceInsertSchema. */
export function insertSchemaName(name: string): string {
    return `${lowerFirst(name)}InsertSchema`;
}

/** Invoice -> invoicePrimaryKeySchema. */
export function primaryKeySchemaName(name: string): string {
    return `${lowerFirst(name)}PrimaryKeySchema`;
}

/** Invoice -> invoiceUpsertSchema. */
export function upsertSchemaName(name: string): string {
    return `${lowerFirst(name)}UpsertSchema`;
}

/** The shared half of a resolution: the spec maps, and where a diagnostic is written. */
interface Resolver {
    aliases: Map<string, SpecTypeAlias>;
    interfaces: Map<string, SpecInterface>;
    report: (location: SpecLocation, message: string) => void;
}

/** The carried state of one entity's resolution: the shared spec, plus what this type reached for. */
interface ResolveContext extends Resolver {
    dependencies: Set<string>;
    usesPrimitives: boolean;
}

/** True for `string & {}`, the open branch an "any other string" union carries. */
function isOpenString(type: SpecType): boolean {
    if (type.kind !== "intersection") {
        return false;
    }
    const hasString = type.members.some((member) => member.kind === "keyword" && member.name === "string");
    const hasEmptyObject = type.members.some(
        (member) => member.kind === "object" && member.members.length === 0,
    );
    return hasString && hasEmptyObject;
}

/** Resolve a named reference: a primitive alias, an entity, or another alias's underlying type. */
function resolveNamedType(name: string, args: string[], context: ResolveContext): string | undefined {
    const builtin = BUILTIN_REFERENCES[name];
    if (builtin) {
        return builtin;
    }
    const alias = context.aliases.get(name);
    // A primitive declares its schema; the generator references it rather than inlining it.
    if (alias?.tags.zod) {
        context.usesPrimitives = true;
        const generic = alias.typeParameters.length > 0;
        return generic
            ? `primitives.${schemaName(name)}<${args.join(", ")}>()`
            : `primitives.${schemaName(name)}`;
    }
    // An entity field holds the entity object, referenced lazily so cycles import safely.
    if (context.interfaces.has(name)) {
        context.dependencies.add(name);
        return `z.lazy(() => ${schemaName(name)})`;
    }
    // A domain alias such as `InvoiceId = BrandedId<"InvoiceId">` resolves through its target.
    return alias ? resolveTypeNode(alias.type, context) : undefined;
}

/** Resolve a union: a string-literal set becomes an enum, anything else a `z.union`. */
function resolveUnion(members: SpecType[], context: ResolveContext): string | undefined {
    const literals: string[] = [];
    let open = false;
    const others: SpecType[] = [];
    for (const member of members) {
        if (member.kind === "stringLiteral") {
            literals.push(member.value);
            continue;
        }
        if (isOpenString(member)) {
            open = true;
            continue;
        }
        others.push(member);
    }
    if (others.length === 0 && literals.length > 0) {
        const enumExpression = `z.enum([${literals.map((value) => JSON.stringify(value)).join(", ")}])`;
        return open ? `${enumExpression}.or(z.string())` : enumExpression;
    }
    const resolved = members.map((member) => resolveTypeNode(member, context));
    if (resolved.some((member) => member === undefined)) {
        return undefined;
    }
    return `z.union([${resolved.join(", ")}])`;
}

/** Resolve an object type literal's members to fields, each carrying its own optionality. */
function resolveObjectFields(members: SpecTypeMember[], context: ResolveContext): ZodField[] | undefined {
    const fields: ZodField[] = [];
    for (const member of members) {
        const resolvedMember = resolveTypeNode(member.type, context);
        if (resolvedMember === undefined) {
            return undefined;
        }
        fields.push({
            name: member.name,
            expression: member.optional ? `${resolvedMember}.optional()` : resolvedMember,
        });
    }
    return fields;
}

/** Resolve a type shape to the Zod expression that validates it. */
function resolveTypeNode(type: SpecType, context: ResolveContext): string | undefined {
    if (type.kind === "keyword") {
        return KEYWORD_SCHEMAS[type.name];
    }

    if (type.kind === "array") {
        const element = resolveTypeNode(type.element, context);
        return element === undefined ? undefined : `z.array(${element})`;
    }

    if (type.kind === "reference") {
        return resolveNamedType(type.name, type.arguments, context);
    }

    if (type.kind === "stringLiteral") {
        return `z.literal(${JSON.stringify(type.value)})`;
    }

    if (type.kind === "numberLiteral") {
        return `z.literal(${type.value})`;
    }

    if (type.kind === "union") {
        return resolveUnion(type.members, context);
    }

    if (type.kind === "intersection") {
        if (isOpenString(type)) {
            return "z.string()";
        }
        for (const member of type.members) {
            const resolved = resolveTypeNode(member, context);
            if (resolved !== undefined) {
                return resolved;
            }
        }
        return undefined;
    }

    if (type.kind === "object") {
        const objectFields = resolveObjectFields(type.members, context);
        if (objectFields === undefined) {
            return undefined;
        }
        if (objectFields.length === 0) {
            return "z.strictObject({})";
        }
        const membersText = objectFields
            .map((field) => `${field.name}: ${field.expression}`)
            .join(", ");
        return `z.strictObject({ ${membersText} })`;
    }

    return undefined;
}

/**
 * The entity a field selects into: its type resolves to an interface, directly or as an
 * array element. The branch tags only say *how* it is stored; the value shape is the type's.
 */
function entityNameOf(type: SpecType, interfaces: Map<string, SpecInterface>): string | undefined {
    const element = type.kind === "array" ? type.element : type;
    if (element.kind !== "reference") {
        return undefined;
    }
    return interfaces.has(element.name) ? element.name : undefined;
}

/** Classify every field of an interface for `select`: scalars take `true`, branches nest. */
function selectFieldsFor(spec: SpecInterface, interfaces: Map<string, SpecInterface>): ZodSelectField[] {
    const fields: ZodSelectField[] = [];
    for (const property of spec.properties) {
        if (property.type.kind === "missing") {
            continue;
        }
        const target = entityNameOf(property.type, interfaces);
        fields.push(target === undefined ? { name: property.name } : { name: property.name, target });
    }
    return fields;
}

/** Build the primitive schemas: the `@primitive` aliases that declare a `@zod` expression. */
function buildPrimitives(aliases: Map<string, SpecTypeAlias>): ZodPrimitive[] {
    const primitives: ZodPrimitive[] = [];
    for (const alias of aliases.values()) {
        if (!alias.tags.primitive || !alias.tags.zod) {
            continue;
        }
        primitives.push({
            name: alias.name,
            schemaName: schemaName(alias.name),
            typeParameters: alias.typeParameters.join(", "),
            expression: alias.tags.zod,
        });
    }
    primitives.sort((a, b) => a.name.localeCompare(b.name));
    return primitives;
}

/** Build every entity's schema, its insert/patch shapes, and the fields a `select` classifies. */
function buildEntities(
    interfaces: Map<string, SpecInterface>,
    resolver: Resolver,
): ZodEntity[] {
    const entities: ZodEntity[] = [];
    for (const spec of interfaces.values()) {
        // Each entity resolves in its own context, so the dependencies it reaches for start empty.
        const context: ResolveContext = { ...resolver, dependencies: new Set(), usesPrimitives: false };
        const fields: ZodField[] = [];
        const required: string[] = [];
        const versionFields: string[] = [];

        for (const property of spec.properties) {
            if (property.type.kind === "missing") {
                resolver.report(property.location, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(property.type, context);
            if (resolved === undefined) {
                resolver.report(
                    property.location,
                    `\`${property.name}\`: unsupported type \`${property.typeText}\``,
                );
                continue;
            }
            fields.push({
                name: property.name,
                expression: property.optional ? `${resolved}.optional()` : resolved,
            });
            if (property.tags.primaryKey || property.tags.version) {
                required.push(property.name);
            }
            if (property.tags.version) {
                versionFields.push(property.name);
            }
        }

        // A self-reference is not imported; the schema is in the same module.
        context.dependencies.delete(spec.name);
        // A create and a patch write the same fields; a patch only adds the version back, since the
        // optimistic-lock precondition is not part of what a create writes. See docs/validation.md.
        const insertOmit = omittedFromInsert(spec).map((property) => property.name);
        // Only a required field needs relaxing; an optional one is already omittable.
        const insertOptional = defaultedInsertProperties(spec)
            .filter((property) => !property.optional)
            .map((property) => property.name);
        const patchOmit = omittedFromPatch(spec).map((property) => property.name);
        const patchNullable = nullablePatchProperties(spec).map((property) => property.name);
        entities.push({
            name: spec.name,
            schemaName: schemaName(spec.name),
            patchName: `${lowerFirst(spec.name)}PatchSchema`,
            querySelectName: querySelectSchemaName(spec.name),
            insertName: insertSchemaName(spec.name),
            primaryKeyName: primaryKeySchemaName(spec.name),
            upsertName: upsertSchemaName(spec.name),
            importSpecifier: spec.importSpecifier,
            fields,
            insertOmit,
            insertOptional,
            patchOmit,
            patchNullable,
            insertInlined: inlinedFromInsert(spec).flatMap((property) => {
                const target = entityNameOf(property.type, interfaces);
                return target === undefined ? [] : [{ name: property.name, target }];
            }),
            dependencies: [...context.dependencies].sort((a, b) => a.localeCompare(b)),
            usesPrimitives: context.usesPrimitives,
            required,
            keys: primaryKeyProperties(spec).map((property) => property.name),
            versionFields,
            autoIncrementFields: autoIncrementProperties(spec).map((property) => property.name),
            selectFields: selectFieldsFor(spec, interfaces),
        });
    }
    entities.sort((a, b) => a.name.localeCompare(b.name));
    return entities;
}

/** Build every entity's `query` read: its `@queryFilter` fields and its `@queryWhere` operators. */
function buildQueries(
    interfaces: Map<string, SpecInterface>,
    resolver: Resolver,
): ZodQuery[] {
    const queries: ZodQuery[] = [];
    for (const spec of interfaces.values()) {
        const context: ResolveContext = { ...resolver, dependencies: new Set(), usesPrimitives: false };
        const fields: ZodField[] = [];
        for (const property of spec.properties) {
            if (!property.tags.queryFilter) {
                continue;
            }
            if (property.type.kind === "missing") {
                resolver.report(property.location, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(property.type, context);
            if (resolved === undefined) {
                resolver.report(
                    property.location,
                    `\`${property.name}\`: unsupported filter type \`${property.typeText}\``,
                );
                continue;
            }
            fields.push({ name: property.name, expression: `z.array(${resolved}).optional()` });
        }
        context.dependencies.delete(spec.name);
        const orderFields = spec.properties
            .filter((property) => property.tags.queryOrderBy !== undefined)
            .map((property) => property.name);
        const whereFields: ZodWhereField[] = [];
        for (const property of spec.properties) {
            const operators = property.tags.queryWhere?.filter(isCompareOperator);
            if (!operators || operators.length === 0) {
                continue;
            }
            if (property.type.kind === "missing") {
                resolver.report(property.location, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(property.type, context);
            if (resolved === undefined) {
                resolver.report(
                    property.location,
                    `\`${property.name}\`: unsupported where type \`${property.typeText}\``,
                );
                continue;
            }
            whereFields.push({ name: property.name, operators, expression: resolved });
        }
        queries.push({
            entity: spec.name,
            schemaName: `query${spec.name}Schema`,
            fields,
            orderFields,
            whereFields,
            dependencies: [...context.dependencies].sort((a, b) => a.localeCompare(b)),
            usesPrimitives: context.usesPrimitives,
        });
    }
    queries.sort((a, b) => a.entity.localeCompare(b.entity));
    return queries;
}

/** Build the Zod schema model from the parsed spec. */
export function buildZodModel(spec: SpecModel): ZodModel {
    const diagnostics: Diagnostic[] = [];
    const { interfaces, aliases } = spec;

    const report = (location: SpecLocation, message: string) => {
        diagnostics.push({ ...location, message });
    };
    const resolver: Resolver = { aliases, interfaces, report };

    // Entities resolve before queries, so their diagnostics are reported in that order.
    const entities = buildEntities(interfaces, resolver);
    const queries = buildQueries(interfaces, resolver);

    return { primitives: buildPrimitives(aliases), entities, queries, diagnostics };
}
