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
import { generateGuards, guardName, renderGuardModule, run, tenantFieldTypes } from "./generate-guards.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

/** The tenant key type the owned fixture's field is declared with. */
const TENANT_ID = `
/** The unique identifier for a tenant. */
export type TenantId = string;
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
 * @watch all rows
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
    return renderGuardModule(entity, operation, tenantFieldTypes(spec, model).get(entityName));
}

/** `getOwnedTenants` as the runtime test drives it, standing in for the generated lookup. */
type Lookup = (db: unknown, pks: readonly object[]) => Promise<string[]>;

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
        hasPermission: async (scope: string, action: string, tenant?: unknown) => {
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
            "../../db/queries/index.ts": { getOwnedTenants: lookup },
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
        expect(code).toContain('if (!(await ctx.hasPermission("widget", "create"))) {');
        expect(code).toContain('throw new ForbiddenError("missing permission widget:create");');
        expect(code).not.toContain("tenantIds");
    });

    it("reads a tenant-owned read's filter field and checks each tenant", () => {
        const code = moduleOf(OWNED_DOMAIN, "Owned", "query");

        expect(code).toContain('import type { TenantId } from "spec/fixtures/Tenant.ts";');
        expect(code).toContain("const tenants = new Set(argument.filter?.tenantId);");
        expect(code).toContain("if (tenants.size === 0) {");
        expect(code).toContain('if (!(await ctx.hasPermission("owned", "query", tenant))) {');
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
