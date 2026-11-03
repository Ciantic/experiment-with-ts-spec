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
 * @queries query
 * @entity
 */
export interface Marker {
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
    it("lists the repository writes, then the query, then the watch", () => {
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

    it("omits the watch when the entity declares none", () => {
        const spec = build(MARKER);

        expect(entityActions(entityNamed(spec, "Marker"))).toEqual(["create", "update", "query"]);
    });

    it("reads the repository declaration, not its REST exposure", () => {
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

        expect(entityActions(entityNamed(spec, "Gadget"))).toEqual(["create", "update"]);
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

    it("camel-cases a multi-word entity name", () => {
        const spec = build(`
/**
 * @pgTable part_line
 * @repository create
 * @entity
 */
export interface PartLine {
    /** @primaryKey */
    id: string;
}`);

        expect(buildPermissionsModel(spec)).toEqual([{ key: "partLine", actions: ["create"] }]);
    });
});

describe("renderPermissionsModule", () => {
    it("renders one quoted key and action tuple per entity, inside a const", () => {
        const module = renderPermissionsModule([
            { key: "marker", actions: ["create", "update", "query"] },
            { key: "widget", actions: ["query", "watch"] },
        ]);

        expect(module).toContain("export const PERMISSIONS = {");
        expect(module).toContain('    "marker": ["create", "update", "query"],');
        expect(module).toContain('    "widget": ["query", "watch"],');
        expect(module).toContain("} as const;");
    });

    it("renders an empty const when there are no entities", () => {
        expect(renderPermissionsModule([])).toContain("export const PERMISSIONS = {} as const;");
    });

    it("exports the Permissions type as the type of PERMISSIONS", () => {
        expect(renderPermissionsModule([])).toContain("export type Permissions = typeof PERMISSIONS;");
    });

    it("loads to the PERMISSIONS value the SDK reads at runtime", () => {
        const entries: PermissionEntry[] = [{ key: "widget", actions: ["query", "watch"] }];
        const loaded = tsLoadGeneratedModule<Record<string, unknown>>(
            renderPermissionsModule(entries),
            tsStubImports({}),
        );

        expect(loaded.PERMISSIONS).toEqual({ widget: ["query", "watch"] });
        expect(Object.keys(loaded)).toEqual(["PERMISSIONS"]);
    });
});

describe("run", () => {
    it("writes the module to the file named by --out and returns 0", () => {
        const spec = build(WIDGET, MARKER);
        const file = join(tempDir(), "nested", "permissions.ts");

        expect(run(spec, ["--out", file], SILENT)).toBe(0);
        expect(readFileSync(file, "utf8")).toBe(renderPermissionsModule(buildPermissionsModel(spec)));
    });

    it("returns 1 when --out names no file", () => {
        expect(run(build(WIDGET), ["--out"], SILENT)).toBe(1);
    });
});
