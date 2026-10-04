/**
 * Map the parsed spec to the REST surface both generators render: the paths, the
 * methods, the filter fields, and the operations each entity exposes.
 *
 * The model is the shared half. `generate-rest-api.ts` renders it into the
 * server's route table and `generate-rest-client.ts` into the SDK, so neither
 * generator may re-derive a path. See docs/rest-api.md.
 */
import type { Node, Project } from "ts-morph";
import {
    DEFAULT_SPEC_GLOB,
    SPEC_GLOB,
    isCompareOperator,
    lowerFirst,
    parseSpec,
    type Diagnostic,
    type SpecInterface,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

/** The verbs the API uses. A read is `GET`, with its argument in the `q` query parameter. */
export type RestMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One kind of call. The kind decides the path and the argument, not the method. */
export type RestKind = "query" | "create" | "update" | "delete";

/** Where a call carries its argument: the `q` query parameter, or the request body. */
export type RestSource = "query" | "body";

/** One exposed call. */
export interface RestOperation {
    kind: RestKind;
    method: RestMethod;
    path: string;
    source: RestSource;
}

/** One entity's REST surface. */
export interface RestEntity {
    /** The interface name, e.g. `Invoice`. */
    entity: string;
    /** The lower-cased module name, e.g. `invoice`. */
    module: string;
    /** The module specifier that imports the entity, e.g. `spec/domain/Invoice.ts`. */
    importSpecifier: string;
    /** The collection path, e.g. `/invoice`, taken from the `@table` name. */
    path: string;
    /** The primary-key fields, which name the row a write targets; one for a single key. */
    keys: string[];
    /** The `@queryfilter` fields: `query` accepts them all. */
    filters: string[];
    /** The `@queryorderby` fields: `query` accepts them as `order` keys. */
    orderFields: string[];
    /** The `@where` fields with their allowed operators: `query` accepts them as `where` keys. */
    whereFields: { name: string; operators: string[] }[];
    /** The `@version` fields, which a patch requires as the optimistic-lock precondition. */
    versionFields: string[];
    operations: RestOperation[];
}

/** Input paths, overridable so tests can generate from fixtures. */
export interface GenerateOptions {
    /** Where the entities are read from. */
    specGlob?: string;
    /** Where type aliases (including primitives) are read from; defaults to every spec file. */
    aliasGlob?: string;
}

/** The parsed spec mapped to a REST surface, with the problems found while mapping it. */
export interface RestModel {
    entities: RestEntity[];
    /** Problems found in the spec; a generator reports them and refuses to write. */
    diagnostics: Diagnostic[];
}

/** `/invoice/query`. The argument travels in `q`, so it is a `GET` on the collection. */
function queryPath(path: string): string {
    return `${path}/query`;
}

/** The calls one entity exposes, in a stable order. */
function operationsFor(path: string): RestOperation[] {
    // A read is safe and its URL determines its answer, so it is a `GET` with its argument in `q`.
    const operations: RestOperation[] = [
        { kind: "query", method: "GET", path: queryPath(path), source: "query" },
    ];
    operations.push(
        { kind: "create", method: "POST", path, source: "body" },
        { kind: "update", method: "PATCH", path, source: "body" },
        // A delete carries keys, not row data, and a `DELETE` body is not universally relayed.
        { kind: "delete", method: "DELETE", path, source: "query" },
    );
    return operations;
}

/** Map one interface to its REST surface, reading only the annotations the wire depends on. */
function restEntityFor(spec: SpecInterface): RestEntity {
    const properties = spec.properties;
    // The collection path is the table name, so a new entity is exposed with no generator edit.
    const path = `/${spec.tableName}`;
    const whereFields: { name: string; operators: string[] }[] = [];
    for (const property of properties) {
        const operators = (property.tags.where ?? []).filter(isCompareOperator);
        if (operators.length > 0) {
            whereFields.push({ name: property.name, operators });
        }
    }

    return {
        entity: spec.name,
        module: lowerFirst(spec.name),
        importSpecifier: spec.importSpecifier,
        path,
        // The parser defaults `@queryfilter` on a primary key, so a key is always a filter.
        keys: properties.filter((property) => property.tags.primaryKey).map((property) => property.name),
        filters: properties.filter((property) => property.tags.queryfilter).map((property) => property.name),
        orderFields: properties
            .filter((property) => property.tags.queryOrderBy !== undefined)
            .map((property) => property.name),
        whereFields,
        versionFields: properties.filter((property) => property.tags.version).map((property) => property.name),
        operations: operationsFor(path),
    };
}

/** Build the REST model from an in-memory spec project. */
export function buildRestModel(project: Project, options: GenerateOptions = {}): RestModel {
    const specGlob = options.specGlob ?? DEFAULT_SPEC_GLOB;
    const aliasGlob = options.aliasGlob ?? SPEC_GLOB;
    const diagnostics: Diagnostic[] = [];
    const { interfaces } = parseSpec(project, { entityGlob: specGlob, aliasGlob });

    const report = (node: Node, message: string) => {
        const filePath = node.getSourceFile().getFilePath().replace(`${process.cwd()}/`, "");
        diagnostics.push({ filePath, line: node.getStartLineNumber(), message });
    };

    const entities: RestEntity[] = [];
    for (const spec of interfaces.values()) {
        const entity = restEntityFor(spec);
        // A write addresses a row by its key, so a keyless entity has no delete or patch.
        if (entity.keys.length === 0) {
            report(spec.declaration, `\`${spec.name}\`: no \`@primaryKey\` field`);
        }
        entities.push(entity);
    }
    entities.sort((a, b) => a.entity.localeCompare(b.entity));
    return { entities, diagnostics };
}
