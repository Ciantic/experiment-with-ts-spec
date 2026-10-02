/**
 * Map the table model to the REST surface both generators render: the paths, the
 * methods, the filter fields, and the operations each entity exposes.
 *
 * The model is the shared half. `generate-rest-api.ts` renders it into the
 * server's route table and `generate-rest-client.ts` into the SDK, so neither
 * generator may re-derive a path. See docs/rest-api.md.
 */
import { lowerFirst } from "spec/scripts/spec-model.ts";
import type { Table } from "./postgres-model.ts";

/** The verbs the API uses. A read is `GET`, with its argument in the `q` query parameter. */
export type RestMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One kind of call. The kind decides the path and the argument, not the method. */
export type RestKind = "list" | "create" | "update" | "delete";

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
    /** The primary-key field, which names the row a write targets. */
    key: string;
    /** The `@queryfilter` fields: `list` accepts them all. */
    filters: string[];
    /** The `@version` fields, which a patch requires as the optimistic-lock precondition. */
    versionFields: string[];
    operations: RestOperation[];
}

/** The parsed spec, mapped to a REST surface. */
export interface RestModel {
    entities: RestEntity[];
}

/** `/invoice/query`. The argument travels in `q`, so it is a `GET` on the collection. */
function listPath(path: string): string {
    return `${path}/query`;
}

/** The calls one table exposes, in a stable order. */
function operationsFor(table: Table, path: string): RestOperation[] {
    // A read is safe and its URL determines its answer, so it is a `GET` with its argument in `q`.
    const operations: RestOperation[] = [
        { kind: "list", method: "GET", path: listPath(path), source: "query" },
    ];
    operations.push(
        { kind: "create", method: "POST", path, source: "body" },
        { kind: "update", method: "PATCH", path, source: "body" },
        // A delete carries keys, not row data, and a `DELETE` body is not universally relayed.
        { kind: "delete", method: "DELETE", path, source: "query" },
    );
    return operations;
}

/** Build the REST model from the tables shared by every backend generator. */
export function buildRestModel(tables: Map<string, Table>): RestModel {
    const entities: RestEntity[] = [];
    for (const table of tables.values()) {
        // The collection path is the table name, so a new entity is exposed with no generator edit.
        const path = `/${table.name}`;
        entities.push({
            entity: table.interfaceName,
            module: lowerFirst(table.interfaceName),
            importSpecifier: table.importSpecifier,
            path,
            key: table.columns.find((column) => column.primaryKey)?.name ?? "id",
            filters: table.columns.filter((column) => column.queryFilter).map((column) => column.name),
            versionFields: table.columns.filter((column) => column.version).map((column) => column.name),
            operations: operationsFor(table, path),
        });
    }
    entities.sort((a, b) => a.entity.localeCompare(b.entity));
    return { entities };
}
