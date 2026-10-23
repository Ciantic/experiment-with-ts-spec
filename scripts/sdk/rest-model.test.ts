/** Unit tests for the REST model, driven by self-contained fixtures. See docs/testing.md. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec } from "spec/scripts/spec-model.ts";
import { buildRestModel, type RestModel } from "./rest-model.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** A filterable entity: a key, an optional filter, a required filter, an ordering key, a comparable, and a version. */
const WIDGET = `
/**
 * @pgTable widget
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Widget {
    /** @primaryKey */
    id: string;

    /** @queryFilter */
    size: string;

    /** @queryFilter required */
    tenantId: string;

    /** @queryOrderBy default asc */
    createdAt: Date;

    /** @queryWhere gte lte */
    amount: number;

    /** @version */
    version: bigint;
}
`.trim();

/** A bare entity: a key and nothing else. */
const MARKER = `
/**
 * @pgTable marker
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Marker {
    /** @primaryKey */
    id: string;
}
`.trim();

/** An entity keyed by two fields, so a write addresses it by both. */
const TRANSLATION = `
/**
 * @pgTable translation
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Translation {
    /** @primaryKey */
    languageCode: string;

    /** @primaryKey */
    key: string;

    value?: string;
}
`.trim();

/** An entity the spec never keys; a write to it has no row to address. */
const KEYLESS = `
/**
 * @pgTable keyless
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Keyless {
    name: string;
}
`.trim();

/** Build a model from in-memory domain files, so no test reads the real spec. */
function build(domain: Record<string, string>): RestModel {
    const spec = Object.entries(domain).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", `${name}.ts`),
        sourceFileText,
    }));
    return buildRestModel(parseInMemorySpec(spec, { sourceGlob: SPEC_GLOB }));
}

const model = build({ Widget: WIDGET, Marker: MARKER });

/** The diagnostic messages, so an assertion names the rule without the location. */
function messages(diagnostics: RestModel["diagnostics"]): string[] {
    return diagnostics.map((diagnostic) => diagnostic.message);
}

describe("buildRestModel", () => {
    it("keys every entity by its interface name and orders them", () => {
        expect(model.entities.map((entity) => entity.entity)).toEqual(["Marker", "Widget"]);
    });

    it("takes the collection path from the table name", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.path).toBe("/widget");
        expect(widget?.module).toBe("widget");
        expect(widget?.importSpecifier).toBe("spec/fixtures/Widget.ts");
    });

    it("exposes a read, a write, and a delete for every entity", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.operations.map((operation) => operation.kind)).toEqual([
            "query",
            "create",
            "upsert",
            "update",
            "delete",
        ]);
    });

    it("reads with GET and writes with the method each call means, under the id a group names", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.operations).toContainEqual({
            id: "queryWidget",
            kind: "query",
            method: "GET",
            path: "/widget/query",
            source: "query",
        });
        expect(widget?.operations).toContainEqual({
            id: "createWidget",
            kind: "create",
            method: "POST",
            path: "/widget",
            source: "body",
        });
        expect(widget?.operations).toContainEqual({
            id: "upsertWidget",
            kind: "upsert",
            method: "PUT",
            path: "/widget",
            source: "body",
        });
        expect(widget?.operations).toContainEqual({
            id: "updateWidget",
            kind: "update",
            method: "PATCH",
            path: "/widget",
            source: "body",
        });
        expect(widget?.operations).toContainEqual({
            id: "deleteWidget",
            kind: "delete",
            method: "DELETE",
            path: "/widget",
            source: "query",
        });
    });

    it("encodes every call that carries no row data into the query string", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");
        const byKind = new Map(widget?.operations.map((operation) => [operation.kind, operation]));

        expect(byKind.get("query")?.source).toBe("query");
        expect(byKind.get("delete")?.source).toBe("query");
        expect(byKind.get("create")?.source).toBe("body");
        expect(byKind.get("upsert")?.source).toBe("body");
        expect(byKind.get("update")?.source).toBe("body");
    });

    it("records the filter fields, the keys, and the version fields", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");

        expect(widget?.filters).toEqual(["id", "size", "tenantId"]);
        expect(widget?.requiredFilters).toEqual(["tenantId"]);
        expect(widget?.keys).toEqual(["id"]);
        expect(widget?.versionFields).toEqual(["version"]);
    });

    it("records every field of a composite key in declaration order", () => {
        const entity = build({ Translation: TRANSLATION }).entities[0];

        expect(entity?.keys).toEqual(["languageCode", "key"]);
    });

    it("reports an entity with no key rather than emitting a keyless write", () => {
        const diagnostics = build({ Keyless: KEYLESS }).diagnostics;

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "`Keyless`: no `@primaryKey` field",
        ]);
    });

    it("exposes only the writes @restRepository names, keeping the read", () => {
        const audit = `
/**
 * @pgTable audit_log
 * @repository create
 * @restRepository create
 * @queries query
 * @restQueries query
 * @entity
 */
export interface AuditLog {
    /** @primaryKey */
    id: string;
}
`.trim();
        const entity = build({ AuditLog: audit }).entities[0];

        expect(entity?.operations.map((operation) => operation.kind)).toEqual(["query", "create"]);
    });

    it("keeps a generated write out of the surface when @restRepository omits it", () => {
        const internal = `
/**
 * @pgTable internal
 * @repository create update
 * @restRepository create
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Internal {
    /** @primaryKey */
    id: string;
}
`.trim();
        const model = build({ Internal: internal });

        expect(model.entities[0]?.operations.map((operation) => operation.kind)).toEqual([
            "query",
            "create",
        ]);
        expect(model.diagnostics).toEqual([]);
    });

    it("reports an entity that names no operation, and an exposed write it does not generate", () => {
        const bad = `
/**
 * @pgTable bad
 * @repository create
 * @restRepository delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Bad {
    /** @primaryKey */
    id: string;
}
`.trim();
        const diagnostics = build({ Bad: bad }).diagnostics;

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "`Bad`: @restRepository `delete` is not in @repository",
        ]);
    });

    it("reports an entity that carries neither operation tag", () => {
        const unannotated = `
/**
 * @pgTable plain
 * @entity
 */
export interface Plain {
    /** @primaryKey */
    id: string;
}
`.trim();
        const diagnostics = build({ Plain: unannotated }).diagnostics;

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "`Plain`: @repository names no operation",
            "`Plain`: @restRepository names no operation",
        ]);
    });

    it("leaves out the read when the entity does not carry @restQueries", () => {
        const internal = `
/**
 * @pgTable internal
 * @repository create
 * @restRepository create
 * @queries query
 * @entity
 */
export interface Internal {
    /** @primaryKey */
    id: string;
}
`.trim();
        const model = build({ Internal: internal });

        expect(model.entities[0]?.operations.map((operation) => operation.kind)).toEqual(["create"]);
        expect(model.diagnostics).toEqual([]);
    });

    it("reports a read the entity does not generate", () => {
        const bad = `
/**
 * @pgTable bad
 * @repository create
 * @restRepository create
 * @restQueries query
 * @entity
 */
export interface Bad {
    /** @primaryKey */
    id: string;
}
`.trim();
        const diagnostics = build({ Bad: bad }).diagnostics;

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "`Bad`: @restQueries `query` is not in @queries",
        ]);
    });

    it("records the orderable fields", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");
        const marker = model.entities.find((entity) => entity.entity === "Marker");

        expect(widget?.orderFields).toEqual(["createdAt"]);
        expect(marker?.orderFields).toEqual([]);
    });

    it("records the comparable fields with their operators", () => {
        const widget = model.entities.find((entity) => entity.entity === "Widget");
        const marker = model.entities.find((entity) => entity.entity === "Marker");

        expect(widget?.whereFields).toEqual([{ name: "amount", operators: ["gte", "lte"] }]);
        expect(marker?.whereFields).toEqual([]);
    });
});

/** A contract with a REST operation that takes an input and one that does not. */
const INVOICES = `
import type { Widget } from "./Widget.ts";

export interface InvoiceOperations<T> {
    /**
     * Send the invoice.
     *
     * @operation
     * @restOperation POST /invoice/send
     */
    sendInvoice(ctx: T, opts: { invoice: Widget }): Promise<void>;

    /**
     * Receive the invoice.
     *
     * @operation
     * @restOperation POST /invoice/receive
     */
    receiveInvoice(ctx: T): Promise<void>;

    /**
     * Look one up.
     *
     * @operation
     * @restOperation GET /invoice/one
     */
    getInvoice(ctx: T, opts: { id: string }): Promise<void>;
}
`.trim();

describe("@restOperation", () => {
    const withOperations = build({ Widget: WIDGET, Marker: MARKER, InvoiceOperations: INVOICES });

    it("maps each operation to a call with its verb and path", () => {
        const calls = withOperations.operations.map((operation) => [operation.id, operation.method, operation.path]);

        expect(calls).toEqual([
            ["getInvoice", "GET", "/invoice/one"],
            ["receiveInvoice", "POST", "/invoice/receive"],
            ["sendInvoice", "POST", "/invoice/send"],
        ]);
    });

    it("names the contract, the schemas, and the types a caller imports", () => {
        const send = withOperations.operations.find((operation) => operation.id === "sendInvoice");

        expect(send).toMatchObject({
            contract: "InvoiceOperations",
            inputSchemaName: "sendInvoiceSchema",
            inputTypeName: "SendInvoiceInput",
            outputSchemaName: "sendInvoiceOutputSchema",
            outputTypeName: "SendInvoiceOutput",
            hasInput: true,
        });
    });

    it("lets a GET carry its input in the query string and a POST in the body", () => {
        const byId = new Map(withOperations.operations.map((operation) => [operation.id, operation.source]));

        expect(byId.get("getInvoice")).toBe("query");
        expect(byId.get("sendInvoice")).toBe("body");
    });

    it("marks an operation with no input parameter, and names no schema for it", () => {
        const receive = withOperations.operations.find((operation) => operation.id === "receiveInvoice");

        expect(receive?.hasInput).toBe(false);
        expect(receive?.inputSchemaName).toBeUndefined();
        expect(receive?.outputTypeName).toBe("ReceiveInvoiceOutput");
    });

    it("reports an operation whose path an entity route already serves", () => {
        const clash = build({
            Widget: WIDGET,
            Ops: `
export interface Ops<T> {
    /**
     * Clash.
     *
     * @operation
     * @restOperation POST /widget
     */
    clash(ctx: T): Promise<void>;
}`,
        });

        expect(messages(clash.diagnostics)).toEqual([
            "`clash`: POST /widget is already served by `createWidget`",
        ]);
    });

    it("reports two operations that claim one path", () => {
        const clash = build({
            Widget: WIDGET,
            Ops: `
export interface Ops<T> {
    /**
     * One.
     *
     * @operation
     * @restOperation POST /invoice/send
     */
    send(ctx: T): Promise<void>;

    /**
     * Two.
     *
     * @operation
     * @restOperation POST /invoice/send
     */
    resend(ctx: T): Promise<void>;
}`,
        });

        expect(messages(clash.diagnostics)).toEqual([
            "`send`: POST /invoice/send is already served by `resend`",
        ]);
    });
});
