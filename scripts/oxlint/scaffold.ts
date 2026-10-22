/** Oxlint rule for scaffolding: a call that still throws `NotImplemented` has no implementation. See docs/operations.md. */

/** The class a `throw` constructs, e.g. `NotImplemented`; undefined for a rethrow. */
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

/** The rules this plugin exports. */
const plugin = {
    meta: { name: "scaffold" },
    rules: {
        "no-not-implemented": {
            meta: {
                type: "suggestion",
                docs: { description: "Warn about a throw that leaves a call as the generated scaffold." },
            },
            create(context) {
                return {
                    ThrowStatement(node) {
                        if (thrownClass(node.argument) !== "NotImplemented") {
                            return;
                        }
                        context.report({
                            node,
                            message:
                                "this call is still the scaffold; replace `throw new NotImplemented(…)` with the implementation and remove its @throws tag",
                        });
                    },
                };
            },
        },
    },
};

export default plugin;
