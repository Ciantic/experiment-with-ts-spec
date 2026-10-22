/** Oxlint rule for the comment contract: one line of prose per comment, with JSDoc tags allowed after it. See docs/comments.md. */

import { definePlugin, type Context, type ESTree, type SourceCode } from "@oxlint/plugins";

const DEFAULT_MAX_WIDTH = 150;

/** The content of a block comment, with the marker, the `*` margin, and surrounding whitespace removed. */
function blockLines(comment: ESTree.Comment): string[] {
    return comment.value
        .split("\n")
        .map((line) => line.replace(/^\s*\*?\s?/, "").trim())
        .filter((line) => line.length > 0);
}

/** Whether a JSDoc line is a tag, which may repeat and is exempt from the width limit. */
function isTag(line: string): boolean {
    return line.startsWith("@");
}

/** Whether a line comment stands alone on its line rather than trailing code. */
function standalone(source: SourceCode, comment: ESTree.Comment): boolean {
    const line = source.lines[comment.loc.start.line - 1] ?? "";
    return line.slice(0, comment.loc.start.column).trim().length === 0;
}

/** Report prose that does not fit on one line or within the width limit. */
function check(context: Context, comment: ESTree.Comment, lines: string[], maxWidth: number, allowTags: boolean): void {
    const prose = allowTags ? lines.filter((line) => !isTag(line)) : lines;
    if (prose.length > 1) {
        context.report({
            node: comment,
            message: "keep a comment to one line of prose; put the rest in docs/ and leave a pointer",
        });
    }
    for (const line of prose) {
        if (line.length > maxWidth) {
            context.report({
                node: comment,
                message: `comment line is ${line.length} characters; the limit is ${maxWidth}`,
            });
        }
    }
}

const plugin = definePlugin({
    meta: { name: "comments" },
    rules: {
        "single-line": {
            meta: {
                type: "suggestion",
                docs: { description: "Require one line of prose per comment, with JSDoc tags allowed after it." },
                schema: [
                    {
                        type: "object",
                        properties: { maxWidth: { type: "integer", minimum: 1 } },
                        additionalProperties: false,
                    },
                ],
            },
            create(context) {
                const source = context.sourceCode;
                const options = context.options[0] as { maxWidth?: number } | undefined;
                const maxWidth = options?.maxWidth ?? DEFAULT_MAX_WIDTH;
                return {
                    Program() {
                        const comments = source.getAllComments();
                        let index = 0;
                        while (index < comments.length) {
                            const comment = comments[index]!;
                            if (comment.type === "Block") {
                                check(context, comment, blockLines(comment), maxWidth, true);
                                index++;
                                continue;
                            }
                            if (comment.type !== "Line" || !standalone(source, comment)) {
                                index++;
                                continue;
                            }
                            const run = [comment.value.trim()];
                            index++;
                            while (index < comments.length) {
                                const next = comments[index]!;
                                if (
                                    next.type !== "Line" ||
                                    next.loc.start.line !== comments[index - 1]!.loc.end.line + 1 ||
                                    !standalone(source, next)
                                ) {
                                    break;
                                }
                                run.push(next.value.trim());
                                index++;
                            }
                            check(context, comment, run, maxWidth, false);
                        }
                    },
                };
            },
        },
    },
});

export default plugin;
