# Spec tests

An operation can declare the tests it expects, next to the method it declares:
`@testDescribe <text>` opens a block and each `@testIt <text>` written after it
is a test in that block.

```ts
export interface WidgetOperations<T> {
    /**
     * Freeze the widget.
     *
     * @operation
     * @testDescribe freezing a widget
     * @testIt refuses a widget that is already frozen
     * @testIt records who froze it
     * @testDescribe a frozen widget
     * @testIt keeps its original owner
     */
    freezeWidget(ctx: T, opts: { widget: Widget }): Promise<WidgetSnapshot>;
}
```

The tags belong to `@operation`: a method that carries a test tag without it is
a finding, and so is a tag on a field, an interface, or a type alias. Order
carries the structure, so an `@testIt` written before any `@testDescribe` names
no block, and the linter reports it rather than guessing one.

## The generated file

`pnpm generate:spec-tests` writes one `{operation}.spec.test.ts` beside the
operation module, in `packages/backend/src/operations/`; `pnpm generate` runs it
right after the operation scaffold. The suffix keeps the generated test apart
from a hand-written `{operation}.test.ts` for the same operation, so both can
exist.

```ts
// Generated for implementation by: scripts/backend/generate-spec-tests.ts
import { describe, it } from "vitest";
import { NotImplemented } from "sdk/errors.ts";

describe("freezing a widget", () => {
    it("refuses a widget that is already frozen", () => {
        throw new NotImplemented("refuses a widget that is already frozen is scaffolded but not implemented");
    });
    it("records who froze it", () => {
        throw new NotImplemented("records who froze it is scaffolded but not implemented");
    });
});

describe("a frozen widget", () => {
    it("keeps its original owner", () => {
        throw new NotImplemented("keeps its original owner is scaffolded but not implemented");
    });
});
```

The block and test texts are the spec's prose, written as string literals, so a
name containing a quote still renders. The scaffold imports nothing from the
operation under test: which fixtures a test needs is the author's decision, and
`pnpm typecheck` must pass before that decision is made.

Each body throws `NotImplemented`, so a declared test fails until it is written.
That is the point of declaring it: the spec says what the operation owes, and
the suite reports the gap rather than passing over it. The
`scaffold/no-not-implemented` Oxlint rule warns on every body still written that
way, so the gap also shows in `pnpm lint`.

## The spec owns the tests

The tags decide which `describe` and `it` calls the file declares, in order and
under the same blocks. Only the bodies are the author's. A file that is missing a
test, adds one the spec does not declare, renames one, or moves one to another
block does not describe the operation the spec declares, and the run fails rather
than merging the two:

```
packages/backend/src/operations/freezeWidget.spec.test.ts:1: `freezeWidget`: the spec's it("records who froze it") is missing; the spec defines the tests, so the file must match it
```

`pnpm lint` runs the same check through `pnpm lint:spec-tests`, which is
`generate:spec-tests --check`: it writes nothing, so it reports drift without
repairing it. The names are read as string literals, which is how the scaffold
writes them; a name assembled at runtime is not a name the check can compare.

A test's body is free: hooks, fixtures, and extra assertions inside a declared
`it` are the author's code, and the check reads only the names. It reads them
from the source, so a commented-out test still counts as one the file declares.

## Regeneration

The file is regenerated for as long as it is still the scaffold: it asserts
nothing and every `it` it declares throws `NotImplemented`. A spec that adds a
row, rewrites a name, or restructures its blocks reaches a scaffold on the next
run, so a test that is still undeclared is filled in without an author's help.

From the moment a test asserts, the file is hand-written, and its tests have to
keep matching the spec. Deleting the file asks for the scaffold again, at the
cost of the bodies.

An operation that drops its tags loses its scaffold: the file is deleted when it
still throws in every body, and reported when it does not, so a hand-written
test is never deleted for the spec's sake. A `@todo` operation defers its spec
test with everything else.

## What the linter checks

- `@testDescribe` and `@testIt` sit on an `@operation` method.
- `@testIt` follows a `@testDescribe`, which names its block.
- `@testDescribe` carries the text naming its block, and at least one `@testIt`.
- `@testIt` carries the text naming its test.
- Every declared test has a file, and the file declares exactly the spec's
  describes and `it`s, in that order.
