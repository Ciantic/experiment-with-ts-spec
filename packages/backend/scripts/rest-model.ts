/**
 * Map the parsed spec to the REST surface both generators render: the paths, the
 * methods, the filter fields, and the operations each entity exposes.
 *
 * The model is the shared half. `generate-rest-api.ts` renders it into the
 * server's route table and `generate-rest-client.ts` into the SDK, so neither
 * generator may re-derive a path. See docs/rest-api.md.
 */
import {
    READ_OPERATIONS,
    WRITE_OPERATIONS,
    isCompareOperator,
    lowerFirst,
    type Diagnostic,
    type ReadOperation,
    type SpecInterface,
    type SpecLocation,
    type SpecModel,
    type WriteOperation,
} from "spec/scripts/spec-model.ts";

export type { Diagnostic };

/** The verbs the API uses. A read is `GET`, with its argument in the `q` query parameter. */
export type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One kind of call: the operations the spec declares, since the tag is what exposes one. */
export type RestKind = ReadOperation | WriteOperation;

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
    /** The collection path, e.g. `/invoice`, taken from the `@pgTable` name. */
    path: string;
    /** The primary-key fields, which name the row a write targets; one for a single key. */
    keys: string[];
    /** The `@queryFilter` fields: `query` accepts them all. */
    filters: string[];
    /** The `@queryOrderBy` fields: `query` accepts them as `order` keys. */
    orderFields: string[];
    /** The `@queryWhere` fields with their allowed operators: `query` accepts them as `where` keys. */
    whereFields: { name: string; operators: string[] }[];
    /** The `@version` fields, which a patch requires as the optimistic-lock precondition. */
    versionFields: string[];
    operations: RestOperation[];
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

/** The method, carrier, and path of one exposed write. */
function writeOperation(path: string, kind: WriteOperation): RestOperation {
    switch (kind) {
        case "create":
            return { kind, method: "POST", path, source: "body" };
        // An upsert declares a row's whole state and the version it claims, so it replaces: `PUT` is idempotent.
        case "upsert":
            return { kind, method: "PUT", path, source: "body" };
        case "update":
            return { kind, method: "PATCH", path, source: "body" };
        // A delete carries keys, not row data, and a `DELETE` body is not universally relayed.
        case "delete":
            return { kind, method: "DELETE", path, source: "query" };
    }
}

/** The calls one entity exposes, in a stable order: the reads `@restQueries` names, then the writes. */
function operationsFor(path: string, reads: ReadOperation[], writes: WriteOperation[]): RestOperation[] {
    const operations: RestOperation[] = [];
    for (const kind of READ_OPERATIONS) {
        // A read is safe and its URL determines its answer, so it is a `GET` with its argument in `q`.
        if (reads.includes(kind)) {
            operations.push({ kind, method: "GET", path: queryPath(path), source: "query" });
        }
    }
    for (const kind of WRITE_OPERATIONS) {
        if (writes.includes(kind)) {
            operations.push(writeOperation(path, kind));
        }
    }
    return operations;
}

/** Map one interface to its REST surface, reading only the annotations the wire depends on. */
function restEntityFor(spec: SpecInterface): RestEntity {
    const properties = spec.properties;
    // The collection path is the Postgres table name, so a new entity is exposed with no generator edit.
    const path = `/${spec.pgTableName}`;
    const whereFields: { name: string; operators: string[] }[] = [];
    for (const property of properties) {
        const operators = (property.tags.queryWhere ?? []).filter(isCompareOperator);
        if (operators.length > 0) {
            whereFields.push({ name: property.name, operators });
        }
    }

    return {
        entity: spec.name,
        module: lowerFirst(spec.name),
        importSpecifier: spec.importSpecifier,
        path,
        // The parser defaults `@queryFilter` on a primary key, so a key is always a filter.
        keys: properties.filter((property) => property.tags.primaryKey).map((property) => property.name),
        filters: properties.filter((property) => property.tags.queryFilter).map((property) => property.name),
        orderFields: properties
            .filter((property) => property.tags.queryOrderBy !== undefined)
            .map((property) => property.name),
        whereFields,
        versionFields: properties.filter((property) => property.tags.version).map((property) => property.name),
        operations: operationsFor(path, spec.restQueries, spec.restRepositoryOperations),
    };
}

/** Build the REST model from the parsed spec. */
export function buildRestModel(spec: SpecModel): RestModel {
    const diagnostics: Diagnostic[] = [];
    const { interfaces } = spec;

    const report = (location: SpecLocation, message: string) => {
        diagnostics.push({ ...location, message });
    };

    const entities: RestEntity[] = [];
    for (const entitySpec of interfaces.values()) {
        const entity = restEntityFor(entitySpec);
        // A write addresses a row by its key, so a keyless entity has no delete or patch.
        if (entity.keys.length === 0) {
            report(entitySpec.location, `\`${entitySpec.name}\`: no \`@primaryKey\` field`);
        }
        // The two tags are required, and REST can only expose a repository function that exists.
        if (entitySpec.repositoryOperations.length === 0) {
            report(entitySpec.location, `\`${entitySpec.name}\`: @repository names no operation`);
        }
        if (entitySpec.restRepositoryOperations.length === 0) {
            report(entitySpec.location, `\`${entitySpec.name}\`: @restRepository names no operation`);
        }
        for (const operation of entitySpec.restRepositoryOperations) {
            if (!entitySpec.repositoryOperations.includes(operation)) {
                report(
                    entitySpec.location,
                    `\`${entitySpec.name}\`: @restRepository \`${operation}\` is not in @repository`,
                );
            }
        }
        // A read the generator does not write cannot be served, just as a write it does not generate cannot.
        for (const operation of entitySpec.restQueries) {
            if (!entitySpec.queries.includes(operation)) {
                report(
                    entitySpec.location,
                    `\`${entitySpec.name}\`: @restQueries \`${operation}\` is not in @queries`,
                );
            }
        }
        entities.push(entity);
    }
    entities.sort((a, b) => a.entity.localeCompare(b.entity));
    return { entities, diagnostics };
}
