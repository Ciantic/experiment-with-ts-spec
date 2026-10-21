# Operations

A method carrying `@operation` on a contract interface is an operation. The
operations generator scaffolds one backend module per operation under
`packages/backend/src/operations/`, and after that the module is hand-written
code that regeneration only verifies.

`sendInvoice` and `receiveInvoice` in
`packages/spec/src/operations/InvoiceOperations.ts` are the two operations today.

## The contract

The interface is a contract, so it carries no `@entity` and the entity
generators ignore it. It takes at most one type parameter, the context the
backend supplies; the method's first parameter is that context.

```ts
export interface InvoiceOperations<T> {
    /**
     * Send the invoice to the recipient.
     *
     * @throws {InvoiceDetailsError} status=422 when the invoice doesn't have enough details to be sent
     *
     * @operation
     * @restOperation POST /invoice/send
     */
    sendInvoice(ctx: T, opts: {
        invoice: Invoice;
    }): Promise<InvoiceSent>;
}
```

The method name is the operation id, and the file the scaffold writes is named
after it, so two contracts may not declare the same method name. `@restOperation
<verb> <path>` exposes the method on the HTTP surface, with the verb and path
written out rather than derived from the name; `@operation` is what makes it an
operation. A REST operation takes the context and at most one input, since the
wire carries one argument.

`@throws {Class} [status=<code>] reason` names an error the operation raises and
says why. `generate:errors` writes the class itself, so a tag is all it takes to
declare one; the scaffold only copies the tag into its doc comment. See
`docs/errors.md`.

## Scaffolding

`pnpm generate:operations` writes the modules; `pnpm generate` runs it after the
spec lint and before the other generators.

A method the spec adds gets a module that compiles and fails the contract at
runtime rather than at the compiler:

```ts
import type { InvoiceOperations } from "spec/operations/InvoiceOperations.ts";
import type { InvoiceSent } from "spec/domain/InvoiceSent.ts";

/**
 * Send the invoice to the recipient.
 *
 * @throws {InvoiceDetailsError} when the invoice doesn't have enough details to be sent
 */
export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {
    return null as unknown as Promise<InvoiceSent>;
};
```

The contract annotation is the point of the scaffold: the compiler checks the
implementation against the spec's method once the placeholder is replaced. The
generator imports the return type's declarations from the spec, so the
placeholder names the real type.

The scaffold fills the contract's type parameter with `unknown`, and that is the
implementer's first edit. The generator has no opinion on what an operation
receives; it only knows the spec's parameter names. Naming the context also buys
the implementation a typed `ctx`:

```ts
import type { SqlExecutor } from "../db/sql-executor.ts";

export const sendInvoice: InvoiceOperations<{ db: SqlExecutor }>["sendInvoice"] = async (ctx, opts) => {
    // ctx.db is the executor
};
```

The scaffold is written only when the file is missing. It is never rewritten:
from the first generation on, the module is hand-written code, and a later
change to the spec's prose or parameter names does not touch it.

## Regeneration checks

The generator reads the committed module and verifies it still contains the
contract annotation:

```ts
export const sendInvoice: InvoiceOperations<…>["sendInvoice"] = …
```

The type argument may be any context the implementer chose, but the interface
name, the operation name, and the indexed access must all be there. A module that
drops the annotation, or renames the operation, is a finding and fails the run;
the generator does not guess how to repair hand-written code.

Signature compatibility is not re-checked by the generator: `pnpm typecheck`
does that, because the annotation is what connects the module to the spec.

The generator refuses the whole run when the spec itself cannot be scaffolded:

- an operation that takes more than one type parameter, since the backend
  supplies one context;
- two contracts declaring the same method name, since the name is the file name;
- `@restOperation` without `@operation`, and a tag without a verb and a path.

`@throws` findings belong to `generate:errors`, which runs first; an operation
route that would collide with an entity route is reported by the REST model.

A module for an operation the spec drops is not deleted, because the module is
hand-written code by then.

## The context

The context is the implementer's choice, and the generator deliberately does not
choose one: it writes `unknown`, which compiles because the annotation supplies
the parameter types, and says plainly that the implementation must decide.

Every route handler receives one context, `RouteContext` in
`packages/backend/src/http/router.ts`, whose only field is `db`. An operation
annotated `InvoiceOperations<{ db: SqlExecutor }>` — or `<unknown>` — accepts it
unchanged. An operation that wanted more, such as `<{ db: SqlExecutor; clock:
Clock }>`, would fail to compile in the generated route, because the HTTP layer
cannot build a clock. Widening `RouteContext` is therefore a deliberate change:
it is where a request-level dependency is introduced, and the router that
constructs it is hand-written for that reason.

An operation that writes more than one row opens its own boundary with
`ctx.db.transaction(…)`. An operation that only computes takes nothing.

## The route and the client

`@restOperation POST /invoice/send` makes the REST pair render the call from the
same model as the entity routes:

```ts
// packages/backend/src/http/routes/operationRoutes.ts
{
    id: "sendInvoice",
    method: "POST",
    path: "/invoice/send",
    source: "body",
    input: sendInvoiceInputSchema,
    handler: (ctx, body) => sendInvoice(ctx, body as Parameters<typeof sendInvoice>[1]),
}
```

`operationRoutes` is spread into the table the router matches on, so a group can
name the operation by its id. The handler passes the route's context straight to
the module, which is what makes the context choice compile-checked: a module
whose context the backend cannot supply fails at the generated route, not at
runtime.

An operation with no input parameter validates the decoded argument with
`z.undefined()`, and its handler ignores the argument. A `GET` or a `DELETE`
carries its input in `q`; every other verb carries it in the body, exactly as an
entity write does.

The argument schema is generated from the input parameter's type into
`packages/sdk/src/operations/<name>InputSchema.ts` and exported from
`sdk/schemas.ts`. A type the Zod resolver cannot render is a finding, so a REST
operation is never left unvalidated.

The client gets one builder per operation, in a module named after its contract:

```ts
export function sendInvoice(
    opts: Parameters<InvoiceOperations<unknown>["sendInvoice"]>[1],
): Call<Awaited<ReturnType<InvoiceOperations<unknown>["sendInvoice"]>>> {
    return call("sendInvoice", "POST", "/invoice/send", opts);
}
```

The types are read off the contract, so the client never names the context and
follows the spec when the return type changes.

## Errors

An operation's custom error is declared by `@throws` and generated:

```ts
/**
 * @throws {InvoiceDetailsError} status=422 when the invoice doesn't have enough details to be sent
 */
sendInvoice(ctx: T, opts: { invoice: Invoice }): Promise<InvoiceSent>;
```

`generate:errors` writes `InvoiceDetailsError` and registers it under its wire
kind, so the implementation imports it from `sdk/errors.ts` and throws it, and a
client catches it after `apiErrorFromBody` rebuilds it. `status=` defaults to
`400`; see `docs/errors.md` for the tag's grammar and the generator's findings.

A `@throws` tag is documentation and does not narrow the method's type; it names
a class the implementation is expected to throw. The operations generator copies
it into the scaffold's doc comment, and nothing checks that the implementation
actually throws it.

## Deliberately not implemented

- **Per-operation context construction.** Every REST operation receives the one
  `RouteContext`; a dependency another context would need is added to the router,
  not resolved per operation.
- **A response schema.** The result is encoded and typed by the contract, but not
  validated, as with every other call.
- **Deleting a module the spec drops.** The generator cannot tell a stale
  scaffold from an implementation worth keeping.
- **A not-implemented failure.** The placeholder returns `null`, so a forgotten
  implementation answers a null body rather than a `501`.

## Gotchas

- **The scaffold's doc is a copy.** It carries the spec's description and
  `@throws` tags as they were when the file was created; later spec edits do not
  propagate.
- **The placeholder hides a missing implementation.** It returns `null as
  unknown as …`, which typechecks and answers `null`; replace it before relying
  on the operation.
- **The parameter names are the spec's.** They are copied into the arrow
  function, so an unused context parameter is reported by the linter's
  unused-variable rule.
- **The placeholder context is `unknown`.** It compiles, but `ctx` is unusable
  until the implementer narrows the type argument. Widening it past `RouteContext`
  makes the generated route fail to compile, which is the intended pressure.
- **A route without an input sends nothing.** A `POST` with no body decodes to
  `undefined`, which the generated `z.undefined()` accepts; the route ignores the
  argument entirely.
- **The client module is named after the contract.** Two contracts map to two
  modules, so an operation name must still be unique across the spec.
