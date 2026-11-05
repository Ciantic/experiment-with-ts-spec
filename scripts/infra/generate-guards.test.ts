/** Unit tests for the guard module generator, driven by self-contained fixtures. See docs/testing.md. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
    SPEC_SRC_ROOT,
    parseInMemorySpec,
    tsLoadGeneratedModule,
    tsStubImports,
    type SpecModel,
} from "../spec/spec-model.ts";
import { buildRestModel, type RestKind } from "../sdk/rest-model.ts";
import { generateGuards, guardName, renderGuardModule, run } from "./generate-guards.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** The tenancy root the owned fixture links to, whose key names the tenant type. */
const TENANT_ID = `
/** The unique identifier for a tenant. */
export type TenantId = string;

/**
 * @pgTable tenant
 * @tenant
 * @entity
 */
export interface Tenant {
    /** @primaryKey */
    id: TenantId;
}
`.trim();

/** A global entity: every call needs its global permission. */
const WIDGET = `
/**
 * @pgTable widget
 * @repository create
 * @restRepository create
 * @queries query
 * @restQueries query
 * @entity
 */
export interface Widget {
    /** @primaryKey */
    id: string;
}
`.trim();

/** A tenant-scoped entity with every exposed call, so each guard kind is rendered. */
const OWNED = `
/**
 * @pgTable owned
 * @tenantOwned tenantId
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @watchAll
 * @watchRows
 * @restWatch all rows
 * @entity
 */
export interface Owned {
    /** @primaryKey */
    id: string;

    tenantId: TenantId;
}
`.trim();

/** The tenant-owned fixture with the key type it references. */
const OWNED_DOMAIN = { Owned: OWNED, Tenant: TENANT_ID };

/** An optionally tenant-owned entity: a row may belong to no tenant at all. */
const OPTIONAL = `
/**
 * @pgTable optional_entity
 * @tenantOwned tenantId optional
 * @repository create upsert update delete
 * @restRepository create upsert update delete
 * @queries query
 * @restQueries query
 * @entity
 */
export interface OptionalEntity {
    /** @primaryKey */
    id: string;

    tenantId?: TenantId;
}
`.trim();

/** The optionally owned fixture with the root it links to. */
const OPTIONAL_DOMAIN = { OptionalEntity: OPTIONAL, Tenant: TENANT_ID };

/** Parse in-memory domain files, so no test reads the real spec. */
function specOf(domain: Record<string, string>): SpecModel {
    const sources = Object.entries(domain).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, "fixtures", `${name}.ts`),
        sourceFileText,
    }));
    return parseInMemorySpec(sources, { sourceGlob: SPEC_GLOB });
}

/** The guard module a fixture's call renders to. */
function moduleOf(domain: Record<string, string>, entityName: string, kind: RestKind): string {
    const spec = specOf(domain);
    const model = buildRestModel(spec);
    const entity = model.entities.find((candidate) => candidate.entity === entityName);
    if (!entity) {
        throw new Error(`the fixture declares no entity named ${entityName}`);
    }
    const operation = entity.operations.find((candidate) => candidate.kind === kind);
    if (!operation) {
        throw new Error(`the fixture exposes no ${kind} call for ${entityName}`);
    }
    return renderGuardModule(entity, operation, spec.tenantIdType);
}

/** `getOwnedTenants` as the runtime test drives it, standing in for the generated lookup. */
type Lookup = (db: unknown, pks: readonly object[]) => Promise<(string | null)[]>;

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh directory the generator can write into. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "guards-"));
    dirs.push(dir);
    return dir;
}

interface PermissionCall {
    scope: string;
    action: string;
    tenant: unknown;
}

interface GuardRuntime {
    calls: PermissionCall[];
    context: unknown;
}

/** A request context whose permission answers the test supplies. */
function runtime(allow: (tenant: unknown) => boolean = () => true): GuardRuntime {
    const calls: PermissionCall[] = [];
    const context = {
        hasGlobalPermission: async (scope: string, action: string) => {
            calls.push({ scope, action, tenant: undefined });
            return allow(undefined);
        },
        hasTenantPermission: async (scope: string, action: string, tenant: unknown) => {
            calls.push({ scope, action, tenant });
            return allow(tenant);
        },
        db: {},
    };
    return { calls, context };
}

/** Evaluate one rendered guard module, stubbing the pieces its imports reach. */
function loadGuard(code: string, lookup: Lookup = async () => []): Record<string, unknown> {
    class ForbiddenError extends Error {}
    return tsLoadGeneratedModule<Record<string, unknown>>(
        code,
        tsStubImports({
            "sdk/errors.ts": { ForbiddenError },
            "../../db/queries/index.ts": { getOwnedTenants: lookup, getOptionalEntityTenants: lookup },
        }),
    );
}

describe("guardName", () => {
    it("names the check can<Call>", () => {
        const operation = buildRestModel(specOf(OWNED_DOMAIN)).entities[0]?.operations[0];
        if (!operation) {
            throw new Error("the fixture exposes no call");
        }

        expect(guardName(operation)).toBe(`can${(operation.id as string).charAt(0).toUpperCase()}${operation.id.slice(1)}`);
    });
});

describe("renderGuardModule", () => {
    it("guards a global entity inline, with the permission its kind names", () => {
        const code = moduleOf({ Widget: WIDGET }, "Widget", "create");

        expect(code).toContain('import { ForbiddenError } from "sdk/errors.ts";');
        expect(code).toContain("export const canCreateWidget: RouteGuard = async (ctx) => {");
        expect(code).toContain('if (!(await ctx.hasGlobalPermission("widget", "create"))) {');
        expect(code).toContain('throw new ForbiddenError("missing permission widget:create");');
        expect(code).not.toContain("tenantIds");
    });

    it("reads a tenant-owned read's filter field and checks each tenant", () => {
        const code = moduleOf(OWNED_DOMAIN, "Owned", "query");

        expect(code).toContain('import type { TenantId } from "spec/fixtures/Tenant.ts";');
        expect(code).toContain("const tenants = new Set(argument.filter?.tenantId);");
        expect(code).toContain("if (tenants.size === 0) {");
        expect(code).toContain('if (!(await ctx.hasTenantPermission("owned", "query", tenant))) {');
        expect(code).toContain(
            "export const canQueryOwned: RouteGuard<{ filter?: { tenantId?: readonly TenantId[] | undefined } | undefined }>",
        );
        expect(code).not.toContain("getOwnedTenants");
        expect(code).not.toContain("tenantIds");
    });

    it("calls the generated lookup for the keys a delete names", () => {
        const code = moduleOf(OWNED_DOMAIN, "Owned", "delete");

        expect(code).toContain('import type { OwnedPrimaryKey } from "sdk/schemas.ts";');
        expect(code).toContain('import { getOwnedTenants } from "../../db/queries/index.ts";');
        expect(code).toContain("const tenants = new Set(await getOwnedTenants(ctx.db, argument));");
        expect(code).toContain(
            "export const canDeleteOwned: RouteGuard<readonly OwnedPrimaryKey[]> = async (ctx, argument) => {",
        );
        expect(code).not.toContain("tenantIds");
    });

    it("checks the lookup's tenant and the tenant an upsert moves the row to", () => {
        const code = moduleOf(OWNED_DOMAIN, "Owned", "upsert");

        expect(code).toContain("const tenants = new Set([");
        expect(code).toContain("...(await getOwnedTenants(ctx.db, argument)),");
        expect(code).toContain("...argument.flatMap((row) => row.tenantId ?? []),");
        expect(code).toContain("export const canUpsertOwned: RouteGuard<readonly OwnedUpsert[]>");
    });

    it("prefers a watch filter's tenant and falls back to the keys", () => {
        const code = moduleOf(OWNED_DOMAIN, "Owned", "watch");

        expect(code).toContain("const filtered = argument?.filter?.tenantId;");
        expect(code).toContain(
            "const tenants = new Set(filtered !== undefined ? [filtered] : await getOwnedTenants(ctx.db, argument?.pks ?? []));",
        );
    });

    it("accepts a null test on an optional tenant filter, which names no tenant", () => {
        const code = moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "query");

        expect(code).toContain(
            "tenantId?: readonly TenantId[] | { readonly isNull: true } | { readonly isNotNull: true } | undefined",
        );
        expect(code).toContain("const filtered = argument.filter?.tenantId;");
        expect(code).toContain("const tenants = new Set(Array.isArray(filtered) ? filtered : []);");
        expect(code).toContain('"optionalEntity:query names no tenant, which needs the global permission"');
    });

    it("counts an absent tenant on a create as a global row", () => {
        const code = moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "create");

        expect(code).toContain("const tenants = new Set(argument.flatMap((row) => row.tenantId ?? [null]));");
        expect(code).toContain('if (tenant === null) {');
        expect(code).toContain(
            '"optionalEntity:create addresses a row with no tenant, which needs the global permission"',
        );
    });

    it("counts an omitted tenant on an upsert as the null it stores", () => {
        const code = moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "upsert");

        expect(code).toContain("...(await getOptionalEntityTenants(ctx.db, argument)),");
        expect(code).toContain("...argument.flatMap((row) => row.tenantId ?? [null]),");
    });

    it("leaves an omitted tenant on a patch alone, since it keeps the stored value", () => {
        const code = moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "update");

        expect(code).toContain("...argument.flatMap((row) => (row.tenantId === undefined ? [] : [row.tenantId])),");
        expect(code).toContain('if (tenant === null) {');
    });
});

describe("generated guards at runtime", () => {
    it("allows a read on a global permission without checking a tenant", async () => {
        const { calls, context } = runtime(() => true);
        const guard = loadGuard(moduleOf(OWNED_DOMAIN, "Owned", "query")).canQueryOwned as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await guard(context, { filter: { tenantId: "tenant-a" } });

        expect(calls).toEqual([{ scope: "owned", action: "query", tenant: undefined }]);
    });

    it("refuses a read that names no tenant", async () => {
        const { context } = runtime(() => false);
        const guard = loadGuard(moduleOf(OWNED_DOMAIN, "Owned", "query")).canQueryOwned as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await expect(guard(context, { filter: {} })).rejects.toThrow("names no tenant");
    });

    it("refuses an unowned read without the global permission", async () => {
        const { context } = runtime((tenant) => tenant === "tenant-a");
        const guard = loadGuard(moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "query")).canQueryOptionalEntity as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await expect(guard(context, { filter: { tenantId: { isNull: true } } })).rejects.toThrow(
            "needs the global permission",
        );
    });

    it("refuses an unowned create without the global permission", async () => {
        const { context } = runtime((tenant) => tenant === "tenant-a");
        const guard = loadGuard(moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "create")).canCreateOptionalEntity as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await expect(guard(context, [{ id: "1", tenantId: null }])).rejects.toThrow(
            "addresses a row with no tenant, which needs the global permission",
        );
    });

    it("checks only the tenants an optional create names", async () => {
        const { calls, context } = runtime((tenant) => tenant === "tenant-a");
        const guard = loadGuard(moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "create")).canCreateOptionalEntity as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await guard(context, [{ id: "1", tenantId: "tenant-a" }]);

        expect(calls.map((call) => call.tenant)).toEqual([undefined, "tenant-a"]);
    });

    it("refuses a delete when the stored row has no tenant", async () => {
        const { context } = runtime((tenant) => tenant === "tenant-a");
        const guard = loadGuard(moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "delete"), async () => [null])
            .canDeleteOptionalEntity as (ctx: unknown, argument: unknown) => Promise<void>;

        await expect(guard(context, [{ id: "1" }])).rejects.toThrow(
            "addresses a row with no tenant, which needs the global permission",
        );
    });

    it("refuses a patch that clears the tenant without the global permission", async () => {
        const { context } = runtime((tenant) => tenant === "tenant-a");
        const guard = loadGuard(moduleOf(OPTIONAL_DOMAIN, "OptionalEntity", "update"), async () => ["tenant-a"])
            .canUpdateOptionalEntity as (ctx: unknown, argument: unknown) => Promise<void>;

        await expect(guard(context, [{ id: "1", version: 0n, tenantId: null }])).rejects.toThrow(
            "addresses a row with no tenant, which needs the global permission",
        );
    });

    it("looks a delete's keys up and refuses the tenant the session lacks", async () => {
        const { calls, context } = runtime((tenant) => tenant === "tenant-a");
        const lookedUp: (readonly object[])[] = [];
        const lookup: Lookup = async (_db, pks) => {
            lookedUp.push(pks);
            return ["tenant-a", "tenant-b"];
        };
        const guard = loadGuard(moduleOf(OWNED_DOMAIN, "Owned", "delete"), lookup).canDeleteOwned as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await expect(guard(context, [{ id: "1" }])).rejects.toThrow("in tenant tenant-b");
        expect(lookedUp).toEqual([[{ id: "1" }]]);
        expect(calls.map((call) => call.tenant)).toEqual([undefined, "tenant-a", "tenant-b"]);
    });

    it("skips the lookup when the session holds the global permission", async () => {
        const { context } = runtime(() => true);
        const lookedUp: (readonly object[])[] = [];
        const lookup: Lookup = async (_db, pks) => {
            lookedUp.push(pks);
            return ["tenant-a"];
        };
        const guard = loadGuard(moduleOf(OWNED_DOMAIN, "Owned", "delete"), lookup).canDeleteOwned as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await guard(context, [{ id: "1" }]);

        expect(lookedUp).toEqual([]);
    });

    it("checks a watch's filter tenant without reading its keys", async () => {
        const { context } = runtime((tenant) => tenant === "tenant-a");
        const lookedUp: (readonly object[])[] = [];
        const lookup: Lookup = async (_db, pks) => {
            lookedUp.push(pks);
            return ["tenant-b"];
        };
        const guard = loadGuard(moduleOf(OWNED_DOMAIN, "Owned", "watch"), lookup).canWatchOwned as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await guard(context, { pks: [{ id: "1" }], filter: { tenantId: "tenant-a" } });

        expect(lookedUp).toEqual([]);
    });

    it("checks a watch's stored tenants when it names keys only", async () => {
        const { context } = runtime((tenant) => tenant === "tenant-a");
        const lookedUp: (readonly object[])[] = [];
        const lookup: Lookup = async (_db, pks) => {
            lookedUp.push(pks);
            return ["tenant-a"];
        };
        const guard = loadGuard(moduleOf(OWNED_DOMAIN, "Owned", "watch"), lookup).canWatchOwned as (
            ctx: unknown,
            argument: unknown,
        ) => Promise<void>;

        await guard(context, { pks: [{ id: "1" }] });

        expect(lookedUp).toEqual([[{ id: "1" }]]);
    });
});

describe("generateGuards", () => {
    const spec = specOf({ Widget: WIDGET, ...OWNED_DOMAIN });
    const model = buildRestModel(spec);

    it("writes one module per exposed call plus a barrel", () => {
        const files = generateGuards(model, spec);

        expect([...files.keys()].sort()).toEqual([
            "canCreateOwned.ts",
            "canCreateWidget.ts",
            "canDeleteOwned.ts",
            "canQueryOwned.ts",
            "canQueryWidget.ts",
            "canUpdateOwned.ts",
            "canUpsertOwned.ts",
            "canWatchOwned.ts",
            "canWatchOwnedRows.ts",
            "index.ts",
        ]);
    });

    it("re-exports every module from the barrel, sorted", () => {
        const code = generateGuards(model, spec).get("index.ts") ?? "";
        const names = [...code.matchAll(/export \* from "\.\/(.+)\.ts";/g)].map((match) => match[1] ?? "");

        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
        expect(names).toContain("canQueryWidget");
    });
});

describe("run", () => {
    it("writes the modules to the directory named by --out and returns 0", () => {
        const dir = join(tempDir(), "nested", "guards");

        expect(run(specOf({ Widget: WIDGET }), ["--out", dir], SILENT)).toBe(0);
        expect(readFileSync(join(dir, "canQueryWidget.ts"), "utf8")).toContain("export const canQueryWidget");
    });

    it("returns 1 when --out names no directory", () => {
        expect(run(specOf({ Widget: WIDGET }), ["--out"], SILENT)).toBe(1);
    });
});
