/** Unit tests for the operation route renderer and the table the backend serves. See docs/testing.md. */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SPEC_SRC_ROOT, parseInMemorySpec } from "../spec/spec-model.ts";
import { buildRestModel, type RestModel } from "../sdk/rest-model.ts";
import { renderEntityRoutesFiles } from "../infra/generate-entity-routes.ts";
// The drift check drives both route generators from one model, so it lives here with the backend's table.
import { generateRestClient } from "../sdk/generate-rest-client.ts";
import { renderOperationRoutes, renderRouteFiles, renderRoutesIndex } from "./generate-operation-routes.ts";

/** The glob that matches an in-memory fixture, placed so its import specifier looks like a real one. */
const SPEC_GLOB = join(SPEC_SRC_ROOT, "fixtures/**/*.ts");

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
     */
    sendWidget(ctx: T, opts: { widget: Widget }): Promise<Widget>;

    /**
     * Reset the widgets.
     *
     * @operation
     * @restOperation POST /widget/reset
     */
    resetWidgets(ctx: T): Promise<void>;
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

        expect(code).toContain("handler: (ctx, body) => sendWidget(ctx, body as SendWidgetInput)");
        expect(code).toContain('import { sendWidgetSchema, type SendWidgetInput } from "sdk/schemas.ts";');
    });

    it("imports each operation module by file and validates a call with no input against undefined", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('import { sendWidget } from "../../operations/sendWidget.ts";');
        expect(code).toContain('import { z } from "zod";');
        expect(code).toContain("input: z.undefined()");
        expect(code).toContain("handler: (ctx) => resetWidgets(ctx)");
    });

    it("types the table against infra's router", () => {
        const code = renderOperationRoutes(withOperations.operations);

        expect(code).toContain('import type { Route } from "infra";');
    });

    it("writes the operation module even when the spec declares none", () => {
        const files = renderRouteFiles(build({ Widget: WIDGET }));

        expect(files.get("operationRoutes.ts")).toContain("export const operationRoutes: Route[] = [];");
    });
});

describe("renderRoutesIndex", () => {
    const withOperations = build({ Widget: WIDGET, Marker: MARKER, WidgetOperations: OPERATIONS });

    it("spreads infra's entity routes and this package's operation routes", () => {
        const code = renderRoutesIndex(withOperations);

        expect(code).toContain('import { entityRoutes, type Route } from "infra";');
        expect(code).toContain("export const routes: Route[] = [");
        expect(code).toContain("    ...entityRoutes,");
        expect(code).toContain('import { operationRoutes } from "./operationRoutes.ts";');
        expect(code).toContain("    ...operationRoutes,");
    });

    it("gives the operation module and the barrel a file", () => {
        const files = renderRouteFiles(withOperations);

        expect([...files.keys()]).toEqual(["operationRoutes.ts", "index.ts"]);
    });
});

describe("the pair", () => {
    it("exposes exactly the calls the server exposes", () => {
        const model = build({ Widget: WIDGET, Marker: MARKER, WidgetOperations: OPERATIONS });
        // Every route module, barrels included; a barrel names no id, so it adds nothing.
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
