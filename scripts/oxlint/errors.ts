/** Oxlint rules for the error contract: a throw names its error in JSDoc, and never the base `Error`. See docs/errors.md. */

import { definePlugin, type ESTree, type SourceCode } from "@oxlint/plugins";

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

type FunctionNode = ESTree.Function | ESTree.ArrowFunctionExpression;

/** Whether a node is a function whose JSDoc can carry `@throws` tags. */
function isFunctionNode(node: ESTree.Node): node is FunctionNode {
    return FUNCTION_TYPES.has(node.type);
}

/** The class a `throw` constructs, e.g. `VersionConflictError`; undefined for a rethrow. */
function thrownClass(node: ESTree.Node | null | undefined): string | undefined {
    if (!node || node.type !== "NewExpression") {
        return undefined;
    }
    const callee = node.callee;
    if (callee.type === "Identifier") {
        return callee.name;
    }
    if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
        return callee.property.name;
    }
    return undefined;
}

/** Whether a node constructs the base `Error` anywhere inside it, as `throw Object.assign(new Error(…))` does. */
function constructsPlainError(node: unknown): boolean {
    if (!node || typeof node !== "object") {
        return false;
    }
    if ("type" in node && node.type === "NewExpression") {
        const callee = (node as ESTree.NewExpression).callee;
        if (
            (callee.type === "Identifier" && callee.name === "Error") ||
            (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier" && callee.property.name === "Error")
        ) {
            return true;
        }
    }
    for (const [key, value] of Object.entries(node)) {
        if (key === "parent") {
            continue;
        }
        if (Array.isArray(value)) {
            if (value.some(constructsPlainError)) {
                return true;
            }
        } else if (value && typeof value === "object" && constructsPlainError(value)) {
            return true;
        }
    }
    return false;
}

/** The node a function's leading JSDoc sits before: its declaration, export, property, or variable statement. */
function documentedNode(fn: FunctionNode): ESTree.Node {
    let node: ESTree.Node = fn;
    if (fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") {
        const parent = fn.parent;
        if (parent?.type === "VariableDeclarator" && parent.parent?.type === "VariableDeclaration") {
            node = parent.parent;
        } else if (
            parent?.type === "Property" ||
            parent?.type === "MethodDefinition" ||
            parent?.type === "PropertyDefinition"
        ) {
            node = parent;
        }
    }
    if (node.parent?.type === "ExportNamedDeclaration" || node.parent?.type === "ExportDefaultDeclaration") {
        node = node.parent;
    }
    return node;
}

/** The JSDoc block immediately before a node, if the last leading comment is one. */
function jsdocBefore(source: SourceCode, node: ESTree.Node): ESTree.Comment | undefined {
    const comments = source.getCommentsBefore(node);
    const last = comments.at(-1);
    if (!last || !source.getText(last).startsWith("/**")) {
        return undefined;
    }
    return last;
}

/** The `@throws {Type} reason` entries a JSDoc block declares. A blank reason stays blank. */
function throwsTags(comment: ESTree.Comment | undefined): Map<string, string> {
    const tags = new Map<string, string>();
    if (!comment) {
        return tags;
    }
    for (const raw of comment.value.split("\n")) {
        const line = raw.replace(/^\s*\*?\s?/, "");
        const match = /^@throws\s+\{([^}]+)\}\s*(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        for (const type of (match[1] ?? "").split("|")) {
            tags.set(type.trim(), (match[2] ?? "").trim());
        }
    }
    return tags;
}

/** Whether an enclosing function documents `name`; `"blank"` when the tag is there with no reason. */
function documented(source: SourceCode, node: ESTree.Node, name: string): boolean | "blank" {
    let blank = false;
    for (let parent: ESTree.Node | null = node.parent; parent; parent = parent.parent) {
        if (!isFunctionNode(parent)) {
            continue;
        }
        const tags = throwsTags(jsdocBefore(source, documentedNode(parent)));
        if (!tags.has(name)) {
            continue;
        }
        if ((tags.get(name) ?? "").length > 0) {
            return true;
        }
        blank = true;
    }
    return blank ? "blank" : false;
}

/** The rules this plugin exports. */
export default definePlugin({
    meta: { name: "errors" },
    rules: {
        "throws-jsdoc": {
            meta: {
                type: "problem",
                docs: { description: "Require every thrown error to be named in an enclosing function's JSDoc." },
            },
            create(context) {
                const source = context.sourceCode;
                return {
                    ThrowStatement(node) {
                        const name = thrownClass(node.argument);
                        if (name === undefined) {
                            return;
                        }
                        const result = documented(source, node, name);
                        if (result === true) {
                            return;
                        }
                        context.report({
                            node,
                            message:
                                result === "blank"
                                    ? `@throws {${name}} needs a reason, as in \`@throws {${name}} when …\``
                                    : `throw new ${name}(…) needs \`@throws {${name}} why\` in an enclosing function's JSDoc`,
                        });
                    },
                };
            },
        },
        "no-plain-error": {
            meta: {
                type: "problem",
                docs: { description: "Require a specific error subclass instead of the base Error." },
            },
            create(context) {
                return {
                    ThrowStatement(node) {
                        if (constructsPlainError(node.argument)) {
                            context.report({
                                node,
                                message:
                                    "throw a specific AppError subclass, not Error; see docs/errors.md",
                            });
                        }
                    },
                };
            },
        },
    },
});
