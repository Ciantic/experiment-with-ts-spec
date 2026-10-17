/**
 * Oxlint rules for the error contract: a throw names an error its JSDoc documents, and source code
 * throws specific errors rather than the base `Error`. See docs/errors.md.
 */

const FUNCTION_TYPES = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);

/** The class a `throw` constructs, e.g. `VersionConflictError`; undefined for a rethrow. */
function thrownClass(node) {
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
function constructsPlainError(node) {
    if (!node || typeof node !== "object") {
        return false;
    }
    if (node.type === "NewExpression") {
        const callee = node.callee;
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
function documentedNode(fn) {
    let node = fn;
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
function jsdocBefore(source, node) {
    const comments = source.getCommentsBefore(node);
    const last = comments.at(-1);
    if (!last || !source.getText(last).startsWith("/**")) {
        return undefined;
    }
    return last;
}

/** The `@throws {Type} reason` entries a JSDoc block declares. A blank reason stays blank. */
function throwsTags(source, comment) {
    const tags = new Map();
    if (!comment) {
        return tags;
    }
    for (const raw of comment.value.split("\n")) {
        const line = raw.replace(/^\s*\*?\s?/, "");
        const match = /^@throws\s+\{([^}]+)\}\s*(.*)$/.exec(line);
        if (!match) {
            continue;
        }
        for (const type of match[1].split("|")) {
            tags.set(type.trim(), match[2].trim());
        }
    }
    return tags;
}

/** Whether an enclosing function documents `name`; `"blank"` when the tag is there with no reason. */
function documented(source, node, name) {
    let blank = false;
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (!FUNCTION_TYPES.has(parent.type)) {
            continue;
        }
        const tags = throwsTags(source, jsdocBefore(source, documentedNode(parent)));
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
const plugin = {
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
};

export default plugin;
