/** Tests for the Oxlint error rules, driven by fixtures in memory. See docs/errors.md. */
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "./errors.js";

RuleTester.describe = describe;
RuleTester.it = it;

/** A rule tester over modern modules, parsing `.ts` fixtures when a case names one. */
const tester = new RuleTester({ languageOptions: { sourceType: "module" } });

tester.run("throws-jsdoc", plugin.rules["throws-jsdoc"], {
    valid: [
        {
            code: `
                /**
                 * @throws {BoomError} when the call cannot proceed
                 */
                export function documented(): void {
                    throw new BoomError("no");
                }
            `,
            filename: "documented.ts",
        },
        {
            code: `
                /**
                 * @throws {BoomError} when the nested closure refuses
                 */
                export function enclosing(): void {
                    const nested = () => {
                        throw new BoomError("nested");
                    };
                    nested();
                }
            `,
            filename: "enclosing.ts",
        },
        {
            code: `
                /**
                 * @throws {OneError|TwoError} when either refusal happens
                 */
                export function union(): void {
                    throw new OneError("one");
                }
            `,
            filename: "union.ts",
        },
    ],
    invalid: [
        {
            code: `export function missing(): void { throw new BoomError("no"); }`,
            filename: "missing.ts",
            errors: [{ message: /needs `@throws \{BoomError\} why`/ }],
        },
        {
            code: `
                /**
                 * @throws {BoomError}
                 */
                export function blank(): void {
                    throw new BoomError("no");
                }
            `,
            filename: "blank.ts",
            errors: [{ message: /needs a reason/ }],
        },
    ],
});

tester.run("no-plain-error", plugin.rules["no-plain-error"], {
    valid: [
        {
            code: `export function specific(): void { throw new BoomError("no"); }`,
            filename: "specific.ts",
        },
    ],
    invalid: [
        {
            code: `export function plain(): void { throw new Error("no"); }`,
            filename: "plain.ts",
            errors: [{ message: /specific AppError or DbError subclass/ }],
        },
        {
            code: `export function assembled(): void { throw Object.assign(new Error("no"), { code: "X" }); }`,
            filename: "assembled.ts",
            errors: [{ message: /specific AppError or DbError subclass/ }],
        },
    ],
});
