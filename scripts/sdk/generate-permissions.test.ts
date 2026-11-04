/** Unit tests for the permissions generator, driven by self-contained fixtures. See docs/testing.md. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    SPEC_SRC_ROOT,
    parseInMemorySpec,
    tsLoadGeneratedModule,
    tsStubImports,
    type SpecInterface,
    type SpecModel,
} from "../spec/spec-model.ts";
import {
    actionName,
    buildPermissionsModel,
    entityActions,
    renderPermissionsModule,
    run,
    type PermissionEntry,
} from "./generate-permissions.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** An entity with every infra declaration, and the REST exposure of each. */
const WIDGET = `
/**
 * @pgTable widget
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @watch all rows
 * @restWatch all rows
 * @entity
 */
export interface Widget {
    /** @primaryKey */
    id: string;
}
`.trim();

/** An entity with no watch, and only some of the writes. */
const MARKER = `
/**
 * @pgTable marker
 * @repository create update
 * @restRepository create update
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Marker {
    /** @primaryKey */
    id: string;
}
`.trim();

/** An entity scoped to the tenant, which the tenant-owned table lists alongside the full one. */
const OWNED = `
/**
 * @pgTable item
 * @tenantOwned tenantId
 * @repository create update delete
 * @restRepository create update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Item {
    /** @primaryKey */
    id: string;

    tenantId: TenantId;
}
`.trim();

/** The tenancy root, which owns the entities but is not itself @tenantOwned. */
const TENANT_ROOT = `
/**
 * @pgTable tenant
 * @tenant
 * @repository create update
 * @restRepository create update
 * @entity
 */
export interface Tenant {
    /** @primaryKey */
    id: string;
}
`.trim();

/** A contract that is not an entity, which the permissions never list. */
const CONTRACT = `
export interface WidgetOperations<T> {
    /**
     * Rename.
     *
     * @operation
     */
    rename(ctx: T): Promise<void>;
}
`.trim();

/** Build a model from in-memory sources, so no test reads the real spec. */
function build(...declarations: string[]): SpecModel {
    const sources = declarations.map((sourceFileText, index) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", `Declarations${index}.ts`),
        sourceFileText,
    }));
    return parseInMemorySpec(sources, { sourceGlob: SPEC_GLOB });
}

/** The entity a fixture declares, or a failure that names the missing one. */
function entityNamed(spec: SpecModel, name: string): SpecInterface {
    const entity = spec.interfaces.get(name);
    if (!entity) {
        throw new Error(`the fixture declares no entity named ${name}`);
    }
    return entity;
}

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh directory the generator can write into. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "permissions-"));
    dirs.push(dir);
    return dir;
}

describe("entityActions", () => {
    it("lists the REST-exposed writes, then the query, then the watch", () => {
        const spec = build(WIDGET);

        expect(entityActions(entityNamed(spec, "Widget"))).toEqual([
            "create",
            "upsert",
            "update",
            "delete",
            "query",
            "watch",
        ]);
    });

    it("omits the watch when the entity exposes none", () => {
        const spec = build(MARKER);

        expect(entityActions(entityNamed(spec, "Marker"))).toEqual(["create", "update", "query"]);
    });

    it("reads the REST exposure, not the repository declaration", () => {
        const spec = build(`
/**
 * @pgTable gadget
 * @repository create update
 * @restRepository create
 * @entity
 */
export interface Gadget {
    /** @primaryKey */
    id: string;
}`);

        expect(entityActions(entityNamed(spec, "Gadget"))).toEqual(["create"]);
    });

    it("is empty when the entity exposes nothing", () => {
        const spec = build(`
/**
 * @pgTable gadget
 * @repository create update
 * @queries query
 * @entity
 */
export interface Gadget {
    /** @primaryKey */
    id: string;
}`);

        expect(entityActions(entityNamed(spec, "Gadget"))).toEqual([]);
    });
});

describe("buildPermissionsModel", () => {
    it("keys each entity by its camel-cased name, in name order", () => {
        const spec = build(WIDGET, MARKER);

        expect(buildPermissionsModel(spec).map((entry) => entry.key)).toEqual(["marker", "widget"]);
    });

    it("leaves out contracts that are not entities", () => {
        const spec = build(WIDGET, CONTRACT);

        expect(buildPermissionsModel(spec).map((entry) => entry.key)).toEqual(["widget"]);
    });

    it("leaves out an entity that exposes no REST action", () => {
        const spec = build(
            WIDGET,
            `
/**
 * @pgTable gadget
 * @repository create update
 * @queries query
 * @entity
 */
export interface Gadget {
    /** @primaryKey */
    id: string;
}`,
        );

        expect(buildPermissionsModel(spec).map((entry) => entry.key)).toEqual(["widget"]);
    });

    it("keeps an entity whose only action an operation declares", () => {
        const spec = build(
            `
/**
 * @pgTable gadget
 * @repository create update
 * @entity
 */
export interface Gadget {
    /** @primaryKey */
    id: string;
}`,
            `
export interface GadgetOperations<T> {
    /**
     * @operation
     * @restOperation POST /gadget/send
     * @restPermission gadget:send
     */
    sendGadget(ctx: T): Promise<void>;
}`,
        );

        expect(buildPermissionsModel(spec)).toEqual([
            { key: "gadget", name: "Gadget", plural: "gadgets", tenantOwned: false, actions: ["send"] },
        ]);
    });

    it("reads @plural instead of deriving the plural", () => {
        const spec = build(`
/**
 * @pgTable sent_invoice
 * @repository create
 * @restRepository create
 * @plural sent invoices
 * @entity
 */
export interface SentInvoice {
    /** @primaryKey */
    id: string;
}`);

        expect(buildPermissionsModel(spec)[0]?.plural).toBe("sent invoices");
    });

    it("camel-cases a multi-word entity name", () => {
        const spec = build(`
/**
 * @pgTable part_line
 * @repository create
 * @restRepository create
 * @entity
 */
export interface PartLine {
    /** @primaryKey */
    id: string;
}`);

        expect(buildPermissionsModel(spec)).toEqual([
            { key: "partLine", name: "Part Line", plural: "part lines", tenantOwned: false, actions: ["create"] },
        ]);
    });

    it("marks @tenantOwned entities and leaves the others unmarked", () => {
        const spec = build(WIDGET, OWNED);

        expect(buildPermissionsModel(spec).map((entry) => [entry.key, entry.tenantOwned])).toEqual([
            ["item", true],
            ["widget", false],
        ]);
    });

    it("leaves out the @tenant root, which is not owned", () => {
        const spec = build(TENANT_ROOT, OWNED);

        expect(buildPermissionsModel(spec).find((entry) => entry.key === "tenant")?.tenantOwned).toBe(false);
    });

    it("adds the actions @restPermission declares, after the exposed actions", () => {
        const spec = build(
            WIDGET,
            `
export interface WidgetOperations<T> {
    /**
     * @operation
     * @restOperation POST /widget/send
     * @restPermission widget:send
     */
    sendWidget(ctx: T): Promise<void>;
}`,
        );

        expect(buildPermissionsModel(spec).find((entry) => entry.key === "widget")?.actions).toEqual([
            "create",
            "upsert",
            "update",
            "delete",
            "query",
            "watch",
            "send",
        ]);
    });

    it("deduplicates an operation action the entity already declares", () => {
        const spec = build(
            WIDGET,
            `
export interface WidgetOperations<T> {
    /**
     * @operation
     * @restOperation POST /widget/refresh
     * @restPermission widget:query
     */
    refreshWidget(ctx: T): Promise<void>;
}`,
        );

        expect(buildPermissionsModel(spec).find((entry) => entry.key === "widget")?.actions).toEqual([
            "create",
            "upsert",
            "update",
            "delete",
            "query",
            "watch",
        ]);
    });

    it("leaves an unknown scope alone, which the linter reports", () => {
        const spec = build(
            WIDGET,
            `
export interface WidgetOperations<T> {
    /**
     * @operation
     * @restOperation POST /widget/send
     * @restPermission gadget:send
     */
    sendWidget(ctx: T): Promise<void>;
}`,
        );

        expect(buildPermissionsModel(spec).map((entry) => entry.key)).toEqual(["widget"]);
    });
});

describe("actionName", () => {
    it("capitalizes the verb and names the plural", () => {
        expect(actionName("create", "sent invoices")).toBe("Create sent invoices");
        expect(actionName("query", "invoices")).toBe("Query invoices");
    });
});

describe("renderPermissionsModule", () => {
    it("renders one nested entry per entity, inside a const", () => {
        const module = renderPermissionsModule([
            { key: "marker", name: "Marker", plural: "markers", tenantOwned: false, actions: ["create", "update", "query"] },
            { key: "widget", name: "Widget", plural: "widgets", tenantOwned: true, actions: ["query", "watch"] },
        ]);

        expect(module).toContain("export const PERMISSIONS = {");
        expect(module).toContain('    "marker": {');
        expect(module).toContain('        name: "Marker",');
        expect(module).toContain("        tenantOwned: false,");
        expect(module).toContain('            "create": { name: "Create markers" },');
        expect(module).toContain("        tenantOwned: true,");
        expect(module).toContain('            "watch": { name: "Watch widgets" },');
        expect(module).toContain("} as const;");
    });

    it("nests the actions under the entity so tenancy is stated once", () => {
        const module = renderPermissionsModule([
            { key: "item", name: "Item", plural: "items", tenantOwned: true, actions: ["create", "query"] },
        ]);

        expect(module).toContain("        actions: {");
        expect(module).toContain('            "query": { name: "Query items" },');
        expect(module.match(/tenantOwned:/gu)).toHaveLength(1);
    });

    it("renders an empty const when there are no entities", () => {
        expect(renderPermissionsModule([])).toContain("export const PERMISSIONS = {} as const;");
    });

    it("exports the types that name an entity and its actions", () => {
        const module = renderPermissionsModule([]);

        expect(module).toContain("export type Permissions = typeof PERMISSIONS;");
        expect(module).toContain("export type PermissionEntity = keyof Permissions;");
        expect(module).toContain(
            'export type PermissionAction<E extends PermissionEntity> = keyof Permissions[E]["actions"];',
        );
    });

    it("exports the types that name a tenant-scoped entity and its actions", () => {
        const module = renderPermissionsModule([]);

        expect(module).toContain("export type TenantPermissionEntity = {");
        expect(module).toContain('    [E in PermissionEntity]: Permissions[E]["tenantOwned"] extends true ? E : never;');
        expect(module).toContain(
            'export type TenantPermissionAction<E extends TenantPermissionEntity> = keyof Permissions[E]["actions"];',
        );
    });

    it("loads to the nested PERMISSIONS value the SDK reads at runtime", () => {
        const entries: PermissionEntry[] = [
            { key: "widget", name: "Widget", plural: "widgets", tenantOwned: true, actions: ["query", "watch"] },
        ];
        const loaded = tsLoadGeneratedModule<Record<string, unknown>>(
            renderPermissionsModule(entries),
            tsStubImports({}),
        );

        expect(loaded.PERMISSIONS).toEqual({
            widget: {
                name: "Widget",
                tenantOwned: true,
                actions: {
                    query: { name: "Query widgets" },
                    watch: { name: "Watch widgets" },
                },
            },
        });
        expect(Object.keys(loaded)).toEqual(["PERMISSIONS"]);
    });
});

describe("run", () => {
    it("writes the module to the file named by --out and returns 0", () => {
        const spec = build(WIDGET, MARKER, OWNED);
        const file = join(tempDir(), "nested", "permissions.ts");

        expect(run(spec, ["--out", file], SILENT)).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(renderPermissionsModule(buildPermissionsModel(spec)));
    });

    it("returns 1 when --out names no file", () => {
        expect(run(build(WIDGET), ["--out"], SILENT)).toBe(1);
    });
});
