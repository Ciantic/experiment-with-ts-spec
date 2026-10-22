/** Tests for the Oxlint scaffold rule, driven by fixtures in memory. See docs/operations.md. */
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "./scaffold.ts";

RuleTester.describe = describe;
RuleTester.it = it;

/** A rule tester over modern modules, parsing `.ts` fixtures. */
const tester = new RuleTester({ languageOptions: { sourceType: "module" } });

tester.run("no-not-implemented", plugin.rules["no-not-implemented"]!, {
    valid: [
        {
            code: `export function send(): void { throw new InvoiceDetailsError("missing details"); }`,
            filename: "implemented.ts",
        },
        {
            code: `export function send(): void { throw new ErrorLikeNotImplemented("still here"); }`,
            filename: "similar-name.ts",
        },
        {
            code: `const message = "throw new NotImplemented(…)";`,
            filename: "string.ts",
        },
    ],
    invalid: [
        {
            code: `export function send(): void { throw new NotImplemented("send is scaffolded"); }`,
            filename: "scaffold.ts",
            errors: [{ message: /still the scaffold/ }],
        },
        {
            code: `export function send(): void { throw new sdk.NotImplemented("send is scaffolded"); }`,
            filename: "qualified.ts",
            errors: [{ message: /still the scaffold/ }],
        },
    ],
});
