/** Unit tests for the operation route renderer and the exposure check across the generated routes. See docs/testing.md. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec } from "../spec/spec-model.ts";
import { buildRestModel, type RestModel } from "../sdk/rest-model.ts";
import { renderEntityRoutesFiles } from "../infra/generate-entity-routes.ts";
// The drift check drives the route and client generators from one model, so it lives with the routes.
import { generateRestClient } from "../sdk/generate-rest-client.ts";
import { renderOperationRoutes, renderRouteFiles, run } from "./generate-operation-routes.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "**/*.ts");

/** A versioned entity, so the routes cover a patch as well as a plain write. */
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

/** A contract exposing a REST operation with an input and one without. */
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
     */
    resetWidgets(ctx: T): Promise<void>;

    /**
     * Read the widget status.
     *
     * @operation
     * @restOperation GET /widget/status
     * @restPublic
     */
    statusWidgets(ctx: T): Promise<void>;
}
`.trim();

/** Build a model from in-memory domain files, so no test reads the real spec. */
function build(domain: Record<string, string>): RestModel {
    const spec = Object.entries(domain).map(([name, sourceFileText]) => ({
        filePath: join(SPEC_SRC_ROOT, `${name}.ts`),
        sourceFileText,
    }));
    return buildRestModel(parseInMemorySpec(spec, { sourceGlob: SPEC_GLOB }));
}

describe("renderOperationRoutes", () => {
    const withOperations = build({ Widget: WIDGET, Marker: MARKER, WidgetOperations: OPERATIONS });

    it("renders one route per @restOperation, keyed by its id", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('export const operationRoutes: Route[] = [');
        expect(code).toContain('id: "sendWidget"');
        expect(code).toContain('method: "POST"');
        expect(code).toContain('path: "/widget/send"');
        expect(code).toContain("input: sendWidgetSchema");
    });

    it("hands the route's context straight to the operation, so the compiler checks it", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain("handler: (ctx, body) => sendWidget(ctx, body)");
        expect(code).toContain('import { sendWidgetSchema } from "sdk/schemas.ts";');
    });

    it("imports each operation module beside the routes and validates a call with no input against undefined", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('import { sendWidget } from "./sendWidget.ts";');
        expect(code).toContain('import { resetWidgets } from "./resetWidgets.ts";');
        expect(code).toContain('import { z } from "zod";');
        expect(code).toContain("input: z.undefined()");
        expect(code).toContain("handler: (ctx) => resetWidgets(ctx)");
    });

    it("writes one routes module per service, with every import inside that service's directory", () => {
        const grouped = build({
            "widget-service/Widget": WIDGET,
            "widget-service/WidgetOperations": OPERATIONS,
        });

        const files = renderRouteFiles(grouped);
        const code = files.get("widget-service/routes.ts") ?? "";

        expect([...files.keys()]).toEqual(["widget-service/routes.ts"]);
        expect(code).toContain('import { sendWidget } from "./sendWidget.ts";');
        expect(code).toContain('import { resetWidgets } from "./resetWidgets.ts";');
        expect(code).toContain('import { canSendWidget } from "./guards/canSendWidget.ts";');
    });

    it("imports the guard each permission declares and attaches it to the route", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('import { canSendWidget } from "./guards/canSendWidget.ts";');
        expect(code).toContain('import { canResetWidgets } from "./guards/canResetWidgets.ts";');
        expect(code).toContain("        guard: canSendWidget,");
        expect(code).toContain("        guard: canResetWidgets,");
        expect(code).not.toContain("canStatusWidgets");
    });

    it("types the table against infra's router", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('import { defineRoute, type Route } from "infra";');
        expect(code).toContain("    defineRoute({");
        expect(code).toContain("    }),");
    });

    it("writes no routes module when the spec declares no route", () => {
        expect([...renderRouteFiles(build({ Widget: WIDGET })).keys()]).toEqual([]);
    });
});

describe("run", () => {
    const dirs: string[] = [];

    afterEach(() => {
        for (const dir of dirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    /** A fresh directory the generator can write into. */
    function tempDir(): string {
        const dir = mkdtempSync(join(tmpdir(), "operation-routes-"));
        dirs.push(dir);
        return dir;
    }

    /** Parse domain files into a spec, so a run writes from the same sources the renderer tests read. */
    function specOf(domain: Record<string, string>) {
        return parseInMemorySpec(
            Object.entries(domain).map(([name, sourceFileText]) => ({
                filePath: join(SPEC_SRC_ROOT, `${name}.ts`),
                sourceFileText,
            })),
            { sourceGlob: SPEC_GLOB },
        );
    }

    it("writes a routes module per service and prunes the one a dropped group leaves", () => {
        const dir = tempDir();
        const silent = { log: () => undefined, error: () => undefined };
        const grouped = specOf({
            "widget-service/Widget": WIDGET,
            "widget-service/WidgetOperations": OPERATIONS,
        });

        expect(run(grouped, ["--out", dir], silent)).toBe(0);
        expect(existsSync(join(dir, "widget-service", "routes.ts"))).toBe(true);

        expect(run(specOf({ Widget: WIDGET }), ["--out", dir], silent)).toBe(0);
        expect(existsSync(join(dir, "widget-service"))).toBe(false);
    });
});

describe("the pair", () => {
    it("exposes exactly the calls the server exposes", () => {
        const model = build({ Widget: WIDGET, Marker: MARKER, WidgetOperations: OPERATIONS });
        // Every generated route module; the backend's table names no id of its own.
        const exposed = [...renderEntityRoutesFiles(model).values(), ...renderRouteFiles(model).values()].flatMap(
            (content) => [...content.matchAll(/id: "(\w+)",/g)].map((match) => match[1]),
        );
        const called = [...generateRestClient(model).values()].flatMap((content) =>
            [...content.matchAll(/call<.*?>\("(\w+)",/g)].map((match) => match[1]),
        );

        expect(exposed).toContain("sendWidget");
        expect(exposed).toContain("resetWidgets");
        expect([...called].sort()).toEqual([...exposed].sort());
    });
});
