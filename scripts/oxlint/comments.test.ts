/** Tests for the Oxlint comment rule, driven by fixtures in memory. See docs/comments.md. */
import { describe, it } from "node:test";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "./comments.ts";

RuleTester.describe = describe;
RuleTester.it = it;

/** A rule tester over modern modules, parsing `.ts` fixtures. */
const tester = new RuleTester({ languageOptions: { sourceType: "module" } });

const longProse = "x".repeat(151);

tester.run("single-line", plugin.rules["single-line"]!, {
    valid: [
        {
            code: `// one line of prose\nexport const value = 1;`,
            filename: "line.ts",
        },
        {
            code: `/** One line of prose. */\nexport const value = 1;`,
            filename: "block.ts",
        },
        {
            code: `
                /**
                 * Create rows, returning the key of each.
                 * @throws {ShortWriteError} when the insert writes fewer rows than the call supplied
                 */
                export function create(): void {}
            `,
            filename: "documented.ts",
        },
        {
            code: `
                /**
                 * @param rows the rows to write
                 * @throws {ShortWriteError} when the insert writes fewer rows than the call supplied
                 */
                export function create(rows: unknown[]): void {}
            `,
            filename: "tags.ts",
        },
        {
            code: `
                const statuses = {
                    "22P02": 400, // invalid text representation
                    "23505": 409, // unique violation
                };
            `,
            filename: "trailing.ts",
        },
        {
            code: `// first comment\nexport const value = 1;\n// second comment\nexport const other = 2;`,
            filename: "separated.ts",
        },
        {
            code: `// ${"x".repeat(150)}`,
            filename: "limit.ts",
        },
        {
            code: `/**\n * @pgTrigger ${"x".repeat(300)}\n */\nexport const value = 1;`,
            filename: "long-tag.ts",
        },
        {
            code: `// ${"x".repeat(20)}`,
            filename: "option.ts",
            options: [{ maxWidth: 20 }],
        },
    ],
    invalid: [
        {
            code: `
                /**
                 * The first line of prose.
                 * The second line of prose.
                 */
                export function described(): void {}
            `,
            filename: "multi.ts",
            errors: [{ message: /one line of prose/ }],
        },
        {
            code: `
                /**
                 * The first line of prose.
                 * @throws {BoomError} when it refuses
                 * More prose after the tag.
                 */
                export function trailingProse(): void {}
            `,
            filename: "after-tag.ts",
            errors: [{ message: /one line of prose/ }],
        },
        {
            code: `// first line\n// second line\nexport const value = 1;`,
            filename: "run.ts",
            errors: [{ message: /one line of prose/ }],
        },
        {
            code: `/** ${longProse} */\nexport const value = 1;`,
            filename: "width.ts",
            errors: [{ message: /151 characters; the limit is 150/ }],
        },
        {
            code: `// ${"x".repeat(31)}`,
            filename: "option-width.ts",
            options: [{ maxWidth: 30 }],
            errors: [{ message: /31 characters; the limit is 30/ }],
        },
    ],
});
