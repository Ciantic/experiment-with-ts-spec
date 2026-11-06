/** Unit tests for the operation guard scaffold generator, driven by self-contained fixtures and a temp directory. See docs/testing.md. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec, type SpecModel } from "../spec/spec-model.ts";
import { buildRestModel } from "../sdk/rest-model.ts";
import {
    SCAFFOLD_MARKER,
    buildGuardPlans,
    renderGuardScaffold,
    run,
} from "./generate-operation-guards.ts";

/** The generator's two channels with nothing behind them, so an assertion reads the exit code. */
const SILENT = { log: () => undefined, error: () => undefined };

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "**/*.ts");

const WIDGET = `
/**
 * @pgTable widget
 * @entity
 */
export interface Widget {
    /** @primaryKey */
    id: string;
}
`.trim();

const OPERATIONS = `
import type { Widget } from "./Widget.ts";

export interface WidgetOperations<T> {
    /**
     * Send the widget.
     *
     * @operation
     * @restOperation POST /widget/send
     * @restPermission widget:send
     */
    sendWidget(ctx: T, opts: { widget: Widget }): Promise<Widget>;

    /**
     * Reset the widgets.
     *
     * @operation
     * @restOperation POST /widget/reset
     * @restPermission widget:reset
     * @restPermissionGuard canReset
     */
    resetWidgets(ctx: T): Promise<void>;
}
`.trim();

/** Build a spec from in-memory sources, so no test reads the real spec. */
function build(sources: Record<string, string>): SpecModel {
    return parseInMemorySpec(
        Object.entries(sources).map(([name, sourceFileText]) => ({
            filePath: join(SPEC_SRC_ROOT, `${name}.ts`),
            sourceFileText,
        })),
        { sourceGlob: SPEC_GLOB },
    );
}

const dirs: string[] = [];

afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

/** A fresh directory the generator can write into. */
function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "operation-guards-"));
    dirs.push(dir);
    return dir;
}

describe("buildGuardPlans", () => {
    it("derives the guard from the operation id and keeps an explicit name", () => {
        const model = buildRestModel(build({ Widget: WIDGET, WidgetOperations: OPERATIONS }));
        const { plans, diagnostics } = buildGuardPlans(model);

        expect(diagnostics).toEqual([]);
        expect(plans.map((plan) => [plan.name, `${plan.permission.scope}:${plan.permission.action}`])).toEqual([
            ["canReset", "widget:reset"],
            ["canSendWidget", "widget:send"],
        ]);
    });

    it("reports one guard shared by calls with different permissions", () => {
        const model = buildRestModel(
            build({
                Widget: WIDGET,
                WidgetOperations: `
import type { Widget } from "./Widget.ts";

export interface WidgetOperations<T> {
    /**
     * @operation
     * @restOperation POST /widget/send
     * @restPermission widget:send
     * @restPermissionGuard canMutate
     */
    sendWidget(ctx: T, opts: { widget: Widget }): Promise<void>;

    /**
     * @operation
     * @restOperation POST /widget/reset
     * @restPermission widget:reset
     * @restPermissionGuard canMutate
     */
    resetWidgets(ctx: T): Promise<void>;
}`,
            }),
        );
        const { diagnostics } = buildGuardPlans(model);

        expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
            "`sendWidget`: guard `canMutate` is shared with a call that requires a different permission",
        ]);
    });
});

describe("renderGuardScaffold", () => {
    it("names the operation input, the permission, and the guard export", () => {
        const model = buildRestModel(build({ Widget: WIDGET, WidgetOperations: OPERATIONS }));
        const send = buildGuardPlans(model).plans.find((plan) => plan.name === "canSendWidget")!;

        const code = renderGuardScaffold(send);

        expect(code.startsWith(SCAFFOLD_MARKER)).toBe(true);
        expect(code).toContain('import type { RouteGuard } from "infra";');
        expect(code).toContain('import type { SendWidgetInput } from "sdk/schemas.ts";');
        expect(code).toContain("export const canSendWidget: RouteGuard<SendWidgetInput>");
        expect(code).toContain("widget:send");
        expect(code).toContain("NotImplemented");
    });

    it("gives a call with no input an undefined argument", () => {
        const model = buildRestModel(build({ Widget: WIDGET, WidgetOperations: OPERATIONS }));
        const reset = buildGuardPlans(model).plans.find((plan) => plan.name === "canReset")!;

        expect(renderGuardScaffold(reset)).toContain("export const canReset: RouteGuard<undefined>");
    });
});

describe("run", () => {
    const spec = build({ Widget: WIDGET, WidgetOperations: OPERATIONS });

    it("writes a scaffold for every guard and passes --check on the result", () => {
        const dir = tempDir();

        expect(run(spec, ["--out", dir], SILENT)).toBe(0);
        expect(readFileSync(join(dir, "guards", "canSendWidget.ts"), "utf8")).toContain("widget:send");
        expect(readFileSync(join(dir, "guards", "canReset.ts"), "utf8")).toContain("widget:reset");
        expect(run(spec, ["--out", dir, "--check"], SILENT)).toBe(0);
    });

    it("writes a guard under the service directory its contract names", () => {
        const dir = tempDir();
        const grouped = build({
            "widget-service/Widget": WIDGET,
            "widget-service/WidgetOperations": OPERATIONS,
        });

        expect(run(grouped, ["--out", dir], SILENT)).toBe(0);
        expect(readFileSync(join(dir, "widget-service", "guards", "canSendWidget.ts"), "utf8")).toContain("widget:send");
        expect(run(grouped, ["--out", dir, "--check"], SILENT)).toBe(0);
    });

    it("reports a missing guard in --check", () => {
        expect(run(spec, ["--out", tempDir(), "--check"], SILENT)).toBe(1);
    });

    it("reports a guard that no longer names its permission", () => {
        const dir = tempDir();
        expect(run(spec, ["--out", dir], SILENT)).toBe(0);
        writeFileSync(
            join(dir, "guards", "canSendWidget.ts"),
            "export const canSendWidget = async () => undefined;\n",
        );

        expect(run(spec, ["--out", dir, "--check"], SILENT)).toBe(1);
    });

    it("accepts a guard that names the scope and action as separate arguments", () => {
        const dir = tempDir();
        expect(run(spec, ["--out", dir], SILENT)).toBe(0);
        for (const name of ["canSendWidget", "canReset"]) {
            writeFileSync(
                join(dir, "guards", `${name}.ts`),
                name === "canSendWidget"
                    ? 'export const canSendWidget = async (ctx) => ctx.hasGlobalPermission("widget", "send");\n'
                    : 'export const canReset = async (ctx) => ctx.hasGlobalPermission("widget", "reset");\n',
            );
        }

        expect(run(spec, ["--out", dir, "--check"], SILENT)).toBe(0);
    });

    it("reports a guard module that no longer exports its name", () => {
        const dir = tempDir();
        expect(run(spec, ["--out", dir], SILENT)).toBe(0);
        writeFileSync(join(dir, "guards", "canSendWidget.ts"), "/** widget:send */\nexport const other = 1;\n");

        expect(run(spec, ["--out", dir, "--check"], SILENT)).toBe(1);
    });

    it("removes an untouched scaffold the spec no longer references", () => {
        const dir = tempDir();
        mkdirSync(join(dir, "guards"), { recursive: true });
        const file = join(dir, "guards", "canOld.ts");
        writeFileSync(
            file,
            `${SCAFFOLD_MARKER}\nexport const canOld = () => {\n    throw new NotImplemented("canOld is scaffolded");\n};\n`,
        );

        expect(run(build({ Widget: WIDGET }), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(file)).toBe(false);
    });

    it("keeps an implemented guard the spec no longer references", () => {
        const dir = tempDir();
        mkdirSync(join(dir, "guards"), { recursive: true });
        const file = join(dir, "guards", "canOld.ts");
        writeFileSync(file, `${SCAFFOLD_MARKER}\nexport const canOld = () => true;\n`);

        expect(run(build({ Widget: WIDGET }), ["--out", dir], SILENT)).toBe(0);
        expect(existsSync(file)).toBe(true);
    });
});
