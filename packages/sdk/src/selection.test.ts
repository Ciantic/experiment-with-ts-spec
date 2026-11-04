/** Type-level tests for the selection projection. See docs/queries.md. */
import { describe, expect, it } from "vitest";
import type { Selected } from "./selection.ts";

/** A stand-in entity: a required scalar, a nullable one, and an optional branch. */
interface Widget {
    id: string;
    code?: string;
    rows?: { note: string; hidden?: string }[];
}

describe("Selected", () => {
    /** Never called: each annotation is the assertion, checked by `tsc --noEmit`. */
    function assertTypes(): void {
        const required: Selected<Widget, { id: true }> = { id: "w" };
        // @ts-expect-error a selected required field stays required
        const missing: Selected<Widget, { id: true }> = {};
        const optional: Selected<Widget, { code: true }> = {};
        const branch: Selected<Widget, { rows: { select: { note: true } } }> = {
            rows: [{ note: "n" }],
        };
        const wrongBranch: Selected<Widget, { rows: { select: { note: true } } }> = {
            // @ts-expect-error a field the branch does not select is absent
            rows: [{ note: "n", hidden: "h" }],
        };

        void [required, missing, optional, branch, wrongBranch];
    }

    it("keeps a selected field's optionality", () => {
        expect(assertTypes).toBeTypeOf("function");
    });
});
