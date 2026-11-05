/** Map the parsed spec to the REST surface both generators render, so neither re-derives a path or an id. See docs/rest-api.md. */
import {
    READ_OPERATIONS,
    WRITE_OPERATIONS,
    guardNameFor,
    isCompareOperator,
    lowerFirst,
    type Diagnostic,
    type RestPermission,
    type WatchScope,
    type ReadOperation,
    type SpecInterface,
    type SpecLocation,
    type SpecModel,
    type SpecOperation,
    type TenantOwned,
    type TriggerEvent,
    type WriteOperation,
} from "../spec/spec-model.ts";

export type { Diagnostic };

/** The verbs the API uses. A read is `GET`, with its argument in the `q` query parameter. */
export type RestMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** One kind of call: the reads and writes the spec declares, plus the single watch stream. */
export type RestKind = ReadOperation | WriteOperation | "watch";

/** Where a call carries its argument: the `q` query parameter, or the request body. */
export type RestSource = "query" | "body";

/** One exposed call. */
export interface RestOperation {
    /** The name the call goes by: the generated builder's name, and what a group entry names instead of a method and a path. See docs/transactions.md. */
    id: string;
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
    /** The module specifier that imports the entity, e.g. `spec/Widget.ts`. */
    importSpecifier: string;
    /** The collection path, e.g. `/invoice`, taken from the `@pgTable` name. */
    path: string;
    /** The column `@tenantOwned` names and whether it is optional, or absent on a global entity. See docs/tenancy.md. */
    tenantOwned?: TenantOwned;
    /** The primary-key fields, which name the row a write targets; one for a single key. */
    keys: string[];
    /** The `@queryFilter` fields: `query` accepts them all. */
    filters: string[];
    /** The `@queryFilter required` fields: `query` must name them. */
    requiredFilters: string[];
    /** The `@queryOrderBy` fields: `query` accepts them as `order` keys. */
    orderFields: string[];
    /** The `@queryWhere` fields with their allowed operators: `query` accepts them as `where` keys. */
    whereFields: { name: string; operators: string[] }[];
    /** The `@version` fields, which a patch requires as the optimistic-lock precondition. */
    versionFields: string[];
    /** The watch scopes the entity declares. See docs/notifications.md. */
    watch: WatchScope[];
    /** The operations `@watchAll ops=` publishes; absent when the scope is not declared. See docs/notifications.md. */
    watchAllOps?: TriggerEvent[];
    /** The operations `@watchRows ops=` publishes; absent when the scope is not declared. See docs/notifications.md. */
    watchRowsOps?: TriggerEvent[];
    /** The `@restWatch` scopes the route exposes; a subset of {@link watch}. */
    restWatch: WatchScope[];
    /** The `@watchAllFilter` fields, whose values the `all` payload carries. See docs/notifications.md. */
    watchAllFilters: string[];
    /** The `@watchRowsFilter` fields, whose values the `rows` payload carries. See docs/notifications.md. */
    watchRowsFilters: string[];
    operations: RestOperation[];
}

/** One error a call declares with `@throws`, as the client's doc comment repeats it. */
export interface RestOperationError {
    /** The class name, e.g. `InvoiceDetailsError`. */
    name: string;
    /** Why the call reports it, from the tag's text. */
    reason: string;
    /** The status the tag names; the error generator's default applies when absent. */
    status?: number;
}

/** One `@restOperation` call: an operation the spec exposes on the HTTP surface. */
export interface RestOperationCall {
    /** The operation's name, which is also the call id a group entry names, e.g. `sendInvoice`. */
    id: string;
    /** The contract interface that declares it, e.g. `InvoiceOperations`. */
    contract: string;
    method: RestMethod;
    path: string;
    /** Where the call carries its argument: a `GET` or a `DELETE` has no body, so it uses `q`. */
    source: RestSource;
    /** The schema the route validates the argument with; absent when the operation takes no input. */
    inputSchemaName?: string;
    /** The type the input schema derives, e.g. `SendInvoiceInput`; absent when the operation takes no input. */
    inputTypeName?: string;
    /** The type the operation answers, e.g. `SendInvoiceOutput`; the route does not validate it. */
    outputTypeName: string;
    /** The prose from the spec, copied into the generated doc comments. */
    description: string[];
    /** The errors the spec's `@throws` declares, which the client doc comment names. */
    errors: RestOperationError[];
    /** Whether the operation declares an input parameter, which is the argument the wire carries. */
    hasInput: boolean;
    /** The permission the route requires, from `@restPermission`; absent when the route is public. */
    permission?: RestPermission;
    /** The guard that enforces it: from `@restPermissionGuard`, or derived from the id. */
    guardName?: string;
    /** Where the operation is declared, so a generator reports against the tag. */
    location: SpecLocation;
}

/** The parsed spec mapped to a REST surface, with the problems found while mapping it. */
export interface RestModel {
    entities: RestEntity[];
    operations: RestOperationCall[];
    /** Problems found in the spec; a generator reports them and refuses to write. */
    diagnostics: Diagnostic[];
}

/** `/invoice/query`. A read is a `GET` on the collection. */
function readPath(path: string): string {
    return `${path}/query`;
}

/** The name a call goes by: the kind it names and the entity it belongs to, e.g. `queryInvoice`. */
function callId(entity: string, kind: RestKind): string {
    return `${kind}${entity}`;
}

/** The method, carrier, and path of one exposed write. */
function writeOperation(entity: string, path: string, kind: WriteOperation): RestOperation {
    const id = callId(entity, kind);
    switch (kind) {
        case "create":
            return { id, kind, method: "POST", path, source: "body" };
        // An upsert declares a row's whole state and the version it claims, so it replaces: `PUT` is idempotent.
        case "upsert":
            return { id, kind, method: "PUT", path, source: "body" };
        case "update":
            return { id, kind, method: "PATCH", path, source: "body" };
        // A delete carries keys, not row data, and a `DELETE` body is not universally relayed.
        case "delete":
            return { id, kind, method: "DELETE", path, source: "query" };
    }
}

/** The calls one entity exposes, in a stable order: the query, the watch, then the writes. */
function operationsFor(
    entity: string,
    path: string,
    reads: ReadOperation[],
    writes: WriteOperation[],
    watch: WatchScope[],
): RestOperation[] {
    const operations: RestOperation[] = [];
    for (const kind of READ_OPERATIONS) {
        // A read is safe and its URL determines its answer, so it is a `GET` with its argument in `q`.
        if (reads.includes(kind)) {
            operations.push({ id: callId(entity, kind), kind, method: "GET", path: readPath(path), source: "query" });
        }
    }
    if (watch.length > 0) {
        operations.push({ id: callId(entity, "watch"), kind: "watch", method: "GET", path: `${path}/watch`, source: "query" });
    }
    for (const kind of WRITE_OPERATIONS) {
        if (writes.includes(kind)) {
            operations.push(writeOperation(entity, path, kind));
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
        ...(spec.tags.tenantOwned === undefined ? {} : { tenantOwned: spec.tags.tenantOwned }),
        // The parser defaults `@queryFilter` on a primary key, so a key is always a filter.
        keys: properties.filter((property) => property.tags.primaryKey).map((property) => property.name),
        filters: properties.filter((property) => property.tags.queryFilter).map((property) => property.name),
        requiredFilters: properties
            .filter((property) => property.tags.queryFilter?.required)
            .map((property) => property.name),
        orderFields: properties
            .filter((property) => property.tags.queryOrderBy !== undefined)
            .map((property) => property.name),
        whereFields,
        versionFields: properties.filter((property) => property.tags.version).map((property) => property.name),
        watch: spec.watch,
        ...(spec.watchAll === undefined ? {} : { watchAllOps: spec.watchAll }),
        ...(spec.watchRows === undefined ? {} : { watchRowsOps: spec.watchRows }),
        restWatch: spec.restWatch,
        watchAllFilters: spec.watchAllFilters,
        watchRowsFilters: spec.watchRowsFilters,
        operations: operationsFor(spec.name, path, spec.restQueries, spec.restRepositoryOperations, spec.restWatch),
    };
}

/** The distinct errors an operation declares, in source order, without the tag's own bookkeeping. */
function operationErrors(operation: SpecOperation): RestOperationError[] {
    const byName = new Map<string, RestOperationError>();
    for (const error of operation.throws) {
        byName.set(error.name, {
            name: error.name,
            reason: error.reason,
            ...(error.status === undefined ? {} : { status: error.status }),
        });
    }
    return [...byName.values()];
}

/** The `@restOperation` calls, in name order, checked against the ids and paths the entities already claim. */
function restOperationCalls(spec: SpecModel, entities: RestEntity[], report: (location: SpecLocation, message: string) => void): RestOperationCall[] {
    const claims = new Map<string, string>();
    for (const entity of entities) {
        for (const operation of entity.operations) {
            claims.set(`${operation.method} ${operation.path}`, operation.id);
            claims.set(operation.id, `${operation.method} ${operation.path}`);
        }
    }

    const calls: RestOperationCall[] = [];
    for (const operation of spec.operations) {
        if (!operation.rest) {
            continue;
        }
        const { restMethod, restPath } = operation;
        if (restMethod === undefined || restPath === undefined) {
            // Lint reports the malformed tag; a generator cannot place a route without a verb and a path.
            continue;
        }
        const route = `${restMethod} ${restPath}`;
        if (claims.has(operation.name)) {
            report(operation.location, `\`${operation.name}\`: the id is already a route's id`);
            continue;
        }
        if (claims.has(route)) {
            report(operation.location, `\`${operation.name}\`: ${route} is already served by \`${claims.get(route)}\``);
            continue;
        }
        claims.set(operation.name, route);
        claims.set(route, operation.name);
        calls.push({
            id: operation.name,
            contract: operation.interfaceName,
            method: restMethod as RestMethod,
            path: restPath,
            source: restMethod === "GET" || restMethod === "DELETE" ? "query" : "body",
            ...(operation.parameters.length > 1
                ? {
                      inputSchemaName: `${operation.name}Schema`,
                      inputTypeName: `${operation.name.charAt(0).toUpperCase()}${operation.name.slice(1)}Input`,
                  }
                : {}),
            outputTypeName: `${operation.name.charAt(0).toUpperCase()}${operation.name.slice(1)}Output`,
            description: operation.description,
            errors: operationErrors(operation),
            hasInput: operation.parameters.length > 1,
            location: operation.location,
            ...(operation.restPermission === undefined
                ? {}
                : {
                      permission: operation.restPermission,
                      guardName: operation.restPermissionGuard ?? guardNameFor(operation.name),
                  }),
        });
    }
    calls.sort((a, b) => a.id.localeCompare(b.id));
    return calls;
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
        // REST can only serve a function that exists, so an exposed operation must be a declared one.
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
        // A notification scope the entity does not declare cannot be served.
        for (const scope of entitySpec.restWatch) {
            if (!entitySpec.watch.includes(scope)) {
                report(
                    entitySpec.location,
                    `\`${entitySpec.name}\`: @restWatch \`${scope}\` is not in @watchAll or @watchRows`,
                );
            }
        }
        // An entity that exposes no call has no surface: no path, and no route or client module.
        if (entity.operations.length === 0) {
            continue;
        }
        // A write addresses a row by its key, so a keyless entity has no delete or patch.
        if (entity.keys.length === 0) {
            report(entitySpec.location, `\`${entitySpec.name}\`: no \`@primaryKey\` field`);
        }
        if (entitySpec.repositoryOperations.length === 0) {
            report(entitySpec.location, `\`${entitySpec.name}\`: @repository names no operation`);
        }
        entities.push(entity);
    }
    entities.sort((a, b) => a.entity.localeCompare(b.entity));
    const operations = restOperationCalls(spec, entities, report);
    return { entities, operations, diagnostics };
}
