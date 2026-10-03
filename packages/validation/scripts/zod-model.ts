/**
 * Map the parsed spec to the Zod schema model the generator renders.
 * The parsing lives in `spec/scripts/spec-model.ts`; this file adds the Zod mapping.
 * See docs/validation.md.
 */
import { Node, SyntaxKind, type Project, type TypeLiteralNode, type UnionTypeNode } from "ts-morph";
import {
    DEFAULT_SPEC_GLOB,
    SPEC_GLOB,
    inlinedFromInsert,
    isCompareOperator,
    lowerFirst,
    omittedFromInsert,
    omittedFromPatch,
    parseSpec,
    primaryKeyProperties,
    type Diagnostic,
    type SpecTypeAlias,
    type SpecInterface,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

export { DEFAULT_SPEC_GLOB, SPEC_GLOB, lowerFirst };

/** Input paths, overridable so tests can generate from fixtures. */
export interface GenerateOptions {
    /** Where the entities are read from. */
    specGlob?: string;
    /** Where type aliases (including primitives) are read from; defaults to every spec file. */
    aliasGlob?: string;
}

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
    fileName: string;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.ts`. */
    importSpecifier: string;
    fields: ZodField[];
    /** Field names a create omits, rendered as an `.omit()` of the entity schema. */
    insertOmit: string[];
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
    /** The `@primaryKey` field names, in declaration order, so a patch's mandatory fields can name them. */
    keys: string[];
    /** Every field, classified for `select`: a scalar takes `true`, a branch nests. */
    selectFields: ZodSelectField[];
}

/** One field of a `select`, mirroring `Selection` in `../src/db/selection.ts`. */
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

/** The generated `query` schema for one entity: its `@queryfilter` sets plus `select`. */
export interface ZodQuery {
    /** The entity the read queries, which groups the generated file and supplies `select`. */
    entity: string;
    schemaName: string;
    /** The filter fields, all optional sets; the renderer adds the entity's select schema. */
    fields: ZodField[];
    /** The orderable field names, from `@queryorderby`; the renderer validates `order` against them. */
    orderFields: string[];
    /** The comparable fields, from `@where`; the renderer validates `where` against them. */
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

/** Invoice -> invoice.ts. */
function fileName(name: string): string {
    return `${lowerFirst(name)}.ts`;
}

/** Unwrap `(T)` to `T`, so a parenthesized union member is inspected as itself. */
function unwrapParenthesized(node: Node): Node {
    const parenthesized = node.asKind(SyntaxKind.ParenthesizedType);
    return parenthesized ? parenthesized.getTypeNode() : node;
}

/** The shared half of a resolution: the spec maps, and where a diagnostic is written. */
interface Resolver {
    aliases: Map<string, SpecTypeAlias>;
    interfaces: Map<string, SpecInterface>;
    report: (node: Node, message: string) => void;
}

/** The carried state of one entity's resolution: the shared spec, plus what this type reached for. */
interface ResolveContext extends Resolver {
    dependencies: Set<string>;
    usesPrimitives: boolean;
}

/** The string value of a string-literal type, or undefined for any other node. */
function stringLiteralValue(node: Node): string | undefined {
    const literal = node.asKind(SyntaxKind.LiteralType);
    if (!literal) {
        return undefined;
    }
    const value = literal.getLiteral();
    return Node.isStringLiteral(value) ? value.getLiteralText() : undefined;
}

/** True for `string & {}`, the open branch an "any other string" union carries. */
function isOpenString(node: Node): boolean {
    const intersection = node.asKind(SyntaxKind.IntersectionType);
    if (!intersection) {
        return false;
    }
    const parts = intersection.getTypeNodes();
    const hasString = parts.some((part) => part.getText() === "string");
    const hasEmptyObject = parts.some((part) => {
        const literal = part.asKind(SyntaxKind.TypeLiteral);
        return literal !== undefined && literal.getMembers().length === 0;
    });
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
        const generic = alias.declaration.getTypeParameters().length > 0;
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
    const aliasType = alias?.declaration.getTypeNode();
    return aliasType ? resolveTypeNode(aliasType, context) : undefined;
}

/** Resolve a union: a string-literal set becomes an enum, anything else a `z.union`. */
function resolveUnion(union: UnionTypeNode, context: ResolveContext): string | undefined {
    const literals: string[] = [];
    let open = false;
    const others: Node[] = [];
    for (const raw of union.getTypeNodes()) {
        const member = unwrapParenthesized(raw);
        const value = stringLiteralValue(member);
        if (value !== undefined) {
            literals.push(value);
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
    const members = union.getTypeNodes().map((member) => resolveTypeNode(member, context));
    if (members.some((member) => member === undefined)) {
        return undefined;
    }
    return `z.union([${members.join(", ")}])`;
}

/** Resolve an object type literal's members to fields, each carrying its own optionality. */
function resolveObjectFields(typeLiteral: TypeLiteralNode, context: ResolveContext): ZodField[] | undefined {
    const fields: ZodField[] = [];
    for (const member of typeLiteral.getMembers()) {
        const property = member.asKind(SyntaxKind.PropertySignature);
        if (!property) {
            return undefined;
        }
        const memberType = property.getTypeNode();
        if (!memberType) {
            return undefined;
        }
        const resolvedMember = resolveTypeNode(memberType, context);
        if (resolvedMember === undefined) {
            return undefined;
        }
        fields.push({
            name: property.getName(),
            expression: property.hasQuestionToken() ? `${resolvedMember}.optional()` : resolvedMember,
        });
    }
    return fields;
}

/** Resolve a type node to the Zod expression that validates it. */
function resolveTypeNode(raw: Node, context: ResolveContext): string | undefined {
    const node = unwrapParenthesized(raw);

    if (node.getKindName().endsWith("Keyword")) {
        return KEYWORD_SCHEMAS[node.getText()];
    }

    const array = node.asKind(SyntaxKind.ArrayType);
    if (array) {
        const element = resolveTypeNode(array.getElementTypeNode(), context);
        return element === undefined ? undefined : `z.array(${element})`;
    }

    const reference = node.asKind(SyntaxKind.TypeReference);
    if (reference) {
        const args = reference.getTypeArguments().map((argument) => argument.getText());
        return resolveNamedType(reference.getTypeName().getText(), args, context);
    }

    const literal = node.asKind(SyntaxKind.LiteralType);
    if (literal) {
        const value = literal.getLiteral();
        if (Node.isStringLiteral(value)) {
            return `z.literal(${JSON.stringify(value.getLiteralText())})`;
        }
        if (Node.isNumericLiteral(value)) {
            return `z.literal(${value.getLiteralValue()})`;
        }
        return undefined;
    }

    const union = node.asKind(SyntaxKind.UnionType);
    if (union) {
        return resolveUnion(union, context);
    }

    const intersection = node.asKind(SyntaxKind.IntersectionType);
    if (intersection) {
        if (isOpenString(intersection)) {
            return "z.string()";
        }
        for (const member of intersection.getTypeNodes()) {
            const resolved = resolveTypeNode(member, context);
            if (resolved !== undefined) {
                return resolved;
            }
        }
        return undefined;
    }

    const typeLiteral = node.asKind(SyntaxKind.TypeLiteral);
    if (typeLiteral) {
        const objectFields = resolveObjectFields(typeLiteral, context);
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
function entityNameOf(node: Node, interfaces: Map<string, SpecInterface>): string | undefined {
    const unwrapped = unwrapParenthesized(node);
    const array = unwrapped.asKind(SyntaxKind.ArrayType);
    const element = array ? unwrapParenthesized(array.getElementTypeNode()) : unwrapped;
    const reference = element.asKind(SyntaxKind.TypeReference);
    if (!reference) {
        return undefined;
    }
    const name = reference.getTypeName().getText();
    return interfaces.has(name) ? name : undefined;
}

/** Classify every field of an interface for `select`: scalars take `true`, branches nest. */
function selectFieldsFor(spec: SpecInterface, interfaces: Map<string, SpecInterface>): ZodSelectField[] {
    const fields: ZodSelectField[] = [];
    for (const property of spec.properties) {
        const typeNode = property.declaration.getTypeNode();
        if (!typeNode) {
            continue;
        }
        const target = entityNameOf(typeNode, interfaces);
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
            typeParameters: alias.declaration
                .getTypeParameters()
                .map((parameter) => parameter.getText())
                .join(", "),
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

        for (const property of spec.properties) {
            const typeNode = property.declaration.getTypeNode();
            if (!typeNode) {
                resolver.report(property.declaration, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(typeNode, context);
            if (resolved === undefined) {
                resolver.report(
                    property.declaration,
                    `\`${property.name}\`: unsupported type \`${typeNode.getText()}\``,
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
        }

        // A self-reference is not imported; the schema is in the same module.
        context.dependencies.delete(spec.name);
        // A create and a patch write the same fields; a patch only adds the version back, since the
        // optimistic-lock precondition is not part of what a create writes. See docs/validation.md.
        const insertOmit = omittedFromInsert(spec).map((property) => property.name);
        const patchOmit = omittedFromPatch(spec).map((property) => property.name);
        entities.push({
            name: spec.name,
            schemaName: schemaName(spec.name),
            patchName: `${lowerFirst(spec.name)}PatchSchema`,
            querySelectName: querySelectSchemaName(spec.name),
            insertName: insertSchemaName(spec.name),
            primaryKeyName: primaryKeySchemaName(spec.name),
            fileName: fileName(spec.name),
            importSpecifier: spec.importSpecifier,
            fields,
            insertOmit,
            patchOmit,
            insertInlined: inlinedFromInsert(spec).flatMap((property) => {
                const typeNode = property.declaration.getTypeNode();
                const target = typeNode && entityNameOf(typeNode, interfaces);
                return target === undefined ? [] : [{ name: property.name, target }];
            }),
            dependencies: [...context.dependencies].sort((a, b) => a.localeCompare(b)),
            usesPrimitives: context.usesPrimitives,
            required,
            keys: primaryKeyProperties(spec).map((property) => property.name),
            selectFields: selectFieldsFor(spec, interfaces),
        });
    }
    entities.sort((a, b) => a.name.localeCompare(b.name));
    return entities;
}

/** Build every entity's `query` read: its `@queryfilter` fields and its `@where` operators. */
function buildQueries(
    interfaces: Map<string, SpecInterface>,
    resolver: Resolver,
): ZodQuery[] {
    const queries: ZodQuery[] = [];
    for (const spec of interfaces.values()) {
        const context: ResolveContext = { ...resolver, dependencies: new Set(), usesPrimitives: false };
        const fields: ZodField[] = [];
        for (const property of spec.properties) {
            if (!property.tags.queryfilter) {
                continue;
            }
            const typeNode = property.declaration.getTypeNode();
            if (!typeNode) {
                resolver.report(property.declaration, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(typeNode, context);
            if (resolved === undefined) {
                resolver.report(
                    property.declaration,
                    `\`${property.name}\`: unsupported filter type \`${typeNode.getText()}\``,
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
            const operators = property.tags.where?.filter(isCompareOperator);
            if (!operators || operators.length === 0) {
                continue;
            }
            const typeNode = property.declaration.getTypeNode();
            if (!typeNode) {
                resolver.report(property.declaration, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(typeNode, context);
            if (resolved === undefined) {
                resolver.report(
                    property.declaration,
                    `\`${property.name}\`: unsupported where type \`${typeNode.getText()}\``,
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
export function buildZodModel(project: Project, options: GenerateOptions = {}): ZodModel {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const diagnostics: Diagnostic[] = [];
    const { interfaces, aliases } = parseSpec(project, { entityGlob: specGlob, aliasGlob });

    const report = (node: Node, message: string) => {
        const filePath = node.getSourceFile().getFilePath().replace(`${process.cwd()}/`, "");
        diagnostics.push({ filePath, line: node.getStartLineNumber(), message });
    };
    const resolver: Resolver = { aliases, interfaces, report };

    // Entities resolve before queries, so their diagnostics are reported in that order.
    const entities = buildEntities(interfaces, resolver);
    const queries = buildQueries(interfaces, resolver);

    return { primitives: buildPrimitives(aliases), entities, queries, diagnostics };
}
