/**
 * Map the parsed spec to the `effect/schema` model the generator renders.
 * The parsing lives in `spec/scripts/spec-model.ts`; this file adds the schema mapping.
 * See docs/validation.md.
 */
import { Node, SyntaxKind, type Project, type TypeLiteralNode, type UnionTypeNode } from "ts-morph";
import {
    DEFAULT_SPEC_GLOB,
    SPEC_GLOB,
    lowerFirst,
    parseSpec,
    type Diagnostic,
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

/** One field of an entity schema: the name, the base schema, and whether the field is optional. */
export interface SchemaField {
    name: string;
    /** The schema for the field's type, before optionality is applied. */
    expression: string;
    /** True when the spec field is optional; the renderer wraps it in `Schema.optionalKey`. */
    optional: boolean;
}

/** An entity rendered as a `<name>Schema`, a `<name>PatchSchema`, and a `<name>SelectSchema`. */
export interface SchemaEntity {
    name: string;
    schemaName: string;
    patchName: string;
    /** The schema validating a `select` over this entity. See docs/queries.md. */
    selectName: string;
    fileName: string;
    fields: SchemaField[];
    /** Entity names a field references, so the file imports their schemas. */
    dependencies: string[];
    /** True when a field resolves through a primitive schema. */
    usesPrimitives: boolean;
    /** Fields the patch schema requires: the key, and every `@version` field. */
    required: string[];
    /** Every field, classified for `select`: a scalar takes `true`, a branch nests. */
    selectFields: SchemaSelectField[];
}

/** One field of a `select`, mirroring `Selection` in `spec/src/selection.ts`. */
export interface SchemaSelectField {
    name: string;
    /** The entity a branch selects into; undefined for a scalar field. */
    target?: string;
}

/** A primitive alias rendered as a schema, or a factory when the alias is generic. */
export interface SchemaPrimitive {
    name: string;
    schemaName: string;
    /** The declared type parameters, e.g. `Name extends string`; empty for a plain alias. */
    typeParameters: string;
    /** The type parameter names, in order. Each is also a value parameter the expression may use. */
    parameterNames: string[];
    /** The `@effect` expression, written verbatim. */
    expression: string;
}

/** The parsed spec, mapped to `effect/schema` schemas. */
export interface SchemaModel {
    primitives: SchemaPrimitive[];
    entities: SchemaEntity[];
    queries: SchemaQuery[];
    diagnostics: Diagnostic[];
}

/** The generated `list` schema for one entity: its `@queryfilter` sets plus `select`. */
export interface SchemaQuery {
    /** The entity the read lists, which groups the generated file and supplies `select`. */
    entity: string;
    schemaName: string;
    /** The filter fields, each an optional set; the renderer adds the entity's select schema. */
    fields: SchemaField[];
    /** Entity names the filters reference, so the file imports their schemas. */
    dependencies: string[];
    /** True when a filter resolves through a primitive schema. */
    usesPrimitives: boolean;
}

/** TypeScript keywords to the `effect/schema` value that validates them. */
const KEYWORD_SCHEMAS: Record<string, string> = {
    string: "Schema.String",
    number: "Schema.Number",
    boolean: "Schema.Boolean",
    bigint: "Schema.BigInt",
    symbol: "Schema.Symbol",
    any: "Schema.Any",
    unknown: "Schema.Unknown",
    never: "Schema.Never",
    void: "Schema.Void",
    undefined: "Schema.Undefined",
    null: "Schema.Null",
    object: "Schema.Struct({})",
};

/** Built-in reference types to their `effect/schema`. Only the ones the spec uses. */
const BUILTIN_REFERENCES: Record<string, string> = {
    Date: "Schema.Date",
};

/** Invoice -> invoiceSchema. */
function schemaName(name: string): string {
    return `${lowerFirst(name)}Schema`;
}

/** Invoice -> invoiceSelectSchema. */
export function selectSchemaName(name: string): string {
    return `${lowerFirst(name)}SelectSchema`;
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

/** The carried state of one type resolution: the entities and primitives it reaches for. */
interface ResolveContext {
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

/** Build the `effect/schema` model from the parsed spec. */
export function buildSchemaModel(project: Project, options: GenerateOptions = {}): SchemaModel {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const diagnostics: Diagnostic[] = [];
    const { interfaces, aliases } = parseSpec(project, { entityGlob: specGlob, aliasGlob });

    const relative = (filePath: string) => filePath.replace(`${process.cwd()}/`, "");
    const report = (node: Node, message: string) => {
        diagnostics.push({
            filePath: relative(node.getSourceFile().getFilePath()),
            line: node.getStartLineNumber(),
            message,
        });
    };

    /** Resolve a named reference: a primitive alias, an entity, or another alias's underlying type. */
    function resolveNamedType(name: string, args: string[], context: ResolveContext): string | undefined {
        const builtin = BUILTIN_REFERENCES[name];
        if (builtin) {
            return builtin;
        }
        const alias = aliases.get(name);
        // A primitive declares its schema; the generator references it rather than inlining it.
        if (alias?.tags.effect) {
            context.usesPrimitives = true;
            // `Schema.brand` takes its identifier as a value, so a generic primitive is called
            // with the type arguments as value arguments; see docs/validation-effect.md.
            const generic = alias.declaration.getTypeParameters().length > 0;
            return generic
                ? `primitives.${schemaName(name)}(${args.join(", ")})`
                : `primitives.${schemaName(name)}`;
        }
        // An entity field holds the entity object, referenced lazily so cycles import safely.
        if (interfaces.has(name)) {
            context.dependencies.add(name);
            return `Schema.suspend(() => ${schemaName(name)})`;
        }
        // A domain alias such as `InvoiceId = BrandedId<"InvoiceId">` resolves through its target.
        const aliasType = alias?.declaration.getTypeNode();
        return aliasType ? resolveTypeNode(aliasType, context) : undefined;
    }

    /** Resolve a union: a string-literal set becomes `Schema.Literals`, anything else a `Schema.Union`. */
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
            const literalsExpression = `Schema.Literals([${literals.map((value) => JSON.stringify(value)).join(", ")}])`;
            return open ? `Schema.Union([${literalsExpression}, Schema.String])` : literalsExpression;
        }
        const members = union.getTypeNodes().map((member) => resolveTypeNode(member, context));
        if (members.some((member) => member === undefined)) {
            return undefined;
        }
        return `Schema.Union([${members.join(", ")}])`;
    }

    /** Resolve an object type literal's members to fields, each carrying its own optionality. */
    function resolveObjectFields(typeLiteral: TypeLiteralNode, context: ResolveContext): SchemaField[] | undefined {
        const fields: SchemaField[] = [];
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
                expression: property.hasQuestionToken() ? `Schema.optionalKey(${resolvedMember})` : resolvedMember,
                optional: false,
            });
        }
        return fields;
    }

    /** Resolve a type node to the `effect/schema` expression that validates it, before optionality. */
    function resolveTypeNode(raw: Node, context: ResolveContext): string | undefined {
        const node = unwrapParenthesized(raw);

        if (node.getKindName().endsWith("Keyword")) {
            return KEYWORD_SCHEMAS[node.getText()];
        }

        const array = node.asKind(SyntaxKind.ArrayType);
        if (array) {
            const element = resolveTypeNode(array.getElementTypeNode(), context);
            return element === undefined ? undefined : `Schema.Array(${element})`;
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
                return `Schema.Literal(${JSON.stringify(value.getLiteralText())})`;
            }
            if (Node.isNumericLiteral(value)) {
                return `Schema.Literal(${value.getLiteralValue()})`;
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
                return "Schema.String";
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
                return "Schema.Struct({})";
            }
            const membersText = objectFields
                .map((field) => `${field.name}: ${field.expression}`)
                .join(", ");
            return `Schema.Struct({ ${membersText} })`;
        }

        return undefined;
    }

    /**
     * The entity a field selects into: its type resolves to an interface, directly or as an
     * array element. The branch tags only say *how* it is stored; the value shape is the type's.
     */
    function entityNameOf(node: Node): string | undefined {
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
    function selectFieldsFor(spec: SpecInterface): SchemaSelectField[] {
        const fields: SchemaSelectField[] = [];
        for (const property of spec.properties) {
            const typeNode = property.declaration.getTypeNode();
            if (!typeNode) {
                continue;
            }
            const target = entityNameOf(typeNode);
            fields.push(target === undefined ? { name: property.name } : { name: property.name, target });
        }
        return fields;
    }

    const primitives: SchemaPrimitive[] = [];
    for (const alias of aliases.values()) {
        if (!alias.tags.primitive || !alias.tags.effect) {
            continue;
        }
        primitives.push({
            name: alias.name,
            schemaName: schemaName(alias.name),
            typeParameters: alias.declaration
                .getTypeParameters()
                .map((parameter) => parameter.getText())
                .join(", "),
            parameterNames: alias.declaration.getTypeParameters().map((parameter) => parameter.getName()),
            expression: alias.tags.effect,
        });
    }
    primitives.sort((a, b) => a.name.localeCompare(b.name));

    const entities: SchemaEntity[] = [];
    for (const spec of interfaces.values()) {
        const context: ResolveContext = { dependencies: new Set(), usesPrimitives: false };
        const fields: SchemaField[] = [];
        const required: string[] = [];

        for (const property of spec.properties) {
            const typeNode = property.declaration.getTypeNode();
            if (!typeNode) {
                report(property.declaration, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(typeNode, context);
            if (resolved === undefined) {
                report(property.declaration, `\`${property.name}\`: unsupported type \`${typeNode.getText()}\``);
                continue;
            }
            fields.push({ name: property.name, expression: resolved, optional: property.optional });
            if (property.name === "id" || property.tags.version) {
                required.push(property.name);
            }
        }

        // A self-reference is not imported; the schema is in the same module.
        context.dependencies.delete(spec.name);
        entities.push({
            name: spec.name,
            schemaName: schemaName(spec.name),
            patchName: `${lowerFirst(spec.name)}PatchSchema`,
            selectName: selectSchemaName(spec.name),
            fileName: fileName(spec.name),
            fields,
            dependencies: [...context.dependencies].sort((a, b) => a.localeCompare(b)),
            usesPrimitives: context.usesPrimitives,
            required,
            selectFields: selectFieldsFor(spec),
        });
    }
    entities.sort((a, b) => a.name.localeCompare(b.name));

    // Every entity gets a `list` read: its `@queryfilter` fields are the optional filters, and
    // the renderer adds `select` from the entity itself. The resolvers already read the columns.
    const queries: SchemaQuery[] = [];
    for (const spec of interfaces.values()) {
        const context: ResolveContext = { dependencies: new Set(), usesPrimitives: false };
        const fields: SchemaField[] = [];
        for (const property of spec.properties) {
            if (!property.tags.queryfilter) {
                continue;
            }
            const typeNode = property.declaration.getTypeNode();
            if (!typeNode) {
                report(property.declaration, `\`${property.name}\`: cannot resolve a type node`);
                continue;
            }
            const resolved = resolveTypeNode(typeNode, context);
            if (resolved === undefined) {
                report(property.declaration, `\`${property.name}\`: unsupported filter type \`${typeNode.getText()}\``);
                continue;
            }
            fields.push({ name: property.name, expression: `Schema.Array(${resolved})`, optional: true });
        }
        context.dependencies.delete(spec.name);
        queries.push({
            entity: spec.name,
            schemaName: `${lowerFirst(`list${spec.name}`)}Schema`,
            fields,
            dependencies: [...context.dependencies].sort((a, b) => a.localeCompare(b)),
            usesPrimitives: context.usesPrimitives,
        });
    }
    queries.sort((a, b) => a.entity.localeCompare(b.entity));

    return { primitives, entities, queries, diagnostics };
}
