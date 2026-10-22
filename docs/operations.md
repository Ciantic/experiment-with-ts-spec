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
// Generated for implementation by: scripts/generate-operations.ts
import type { InvoiceOperations } from "spec/operations/InvoiceOperations.ts";
import { NotImplemented } from "sdk/errors.ts";

/**
 * Send the invoice to the recipient.
 *
 * @throws {InvoiceDetailsError} when the invoice doesn't have enough details to be sent
 * @throws {NotImplemented} when the operation is still the scaffold; remove this tag with the throw
 */
export const sendInvoice: InvoiceOperations<unknown>["sendInvoice"] = async (ctx, opts) => {
    throw new NotImplemented("sendInvoice is scaffolded but not implemented");
};
```

The contract annotation is the point of the scaffold: the compiler checks the
implementation against the spec's method once the body is replaced. The body
throws `NotImplemented`, which is how a forgotten operation answers `501` rather
than a null the client has to interpret. The doc comment carries the tag the
lint rule requires for that throw; remove the tag together with the throw. The
`scaffold/no-not-implemented` Oxlint rule warns on a `throw new NotImplemented`,
so a call left as its scaffold is visible in `pnpm lint`. See `docs/errors.md`.

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

The first line names the generator and says the file is there to be implemented.
It is a provenance line rather than an ownership claim: the file is yours from
the moment it is written.

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

## Removing an operation

The generator owns the set of files under `src/operations/`, but only the
scaffold half of each one. When the spec no longer declares an operation it
decides by the module's contents:

- **A scaffold is deleted.** A module whose only statement throws
  `NotImplemented` carries no implementation to lose, so it is removed. The
  `Generated for implementation by: …` line says where the file came from; the
  body is what decides, so an implemented module is never deleted for having kept
  the line.
- **An implementation is kept and reported.** A module that exports a contract
  annotation and has a body of its own is the author's code; the generator names
  the file and fails the run instead of deleting it.
- **A helper is ignored.** A file that declares no contract annotation, such as a
  local clock, is not an operation module and is left alone.

The `removed` count in the generator's summary reports the first case. Routes,
input schemas, and client builders are pruned by their own generators, so
deleting a `@restOperation` from the spec leaves nothing behind once its scaffold
is gone.

## The context

The context is the implementer's choice, and the generator deliberately does not
choose one: it writes `unknown`, which compiles because the annotation supplies
the parameter types, and says plainly that the implementation must decide.

Every route handler receives one context, `RequestContext` in
`packages/backend/src/context.ts`, whose only field is `db`. Startup calls
`createAppContext` once, which opens the in-memory database and applies the
schema; the router calls `createRequestContext(app, request)` per request, which
gives that request its own executor over the shared pool. An operation annotated
`InvoiceOperations<{ db: SqlExecutor }>` — or `<unknown>` — accepts it unchanged.
An operation that wanted more, such as `<{ db: SqlExecutor; clock: Clock }>`,
would fail to compile in the generated route, because the HTTP layer cannot build
a clock. Widening `RequestContext` is therefore a deliberate change: it is where
a request-level dependency is introduced, and `createRequestContext` is
hand-written for that reason. A resource that outlives one request belongs on
`AppContext` instead, because a fresh PGlite instance per request would lose its
data.

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
    input: sendInvoiceSchema,
    handler: (ctx, body) => sendInvoice(ctx, body as SendInvoiceInput),
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

### The wire contract

Each operation gets one module, `packages/sdk/src/operations/<name>Schema.ts`,
holding its input schema, its result schema, and a named type for each:

```ts
/** The argument `sendInvoice` accepts, as the route validates it. */
export const sendInvoiceSchema = z.strictObject({ invoice: z.lazy(() => invoiceSchema) });

/** What `sendInvoice` takes, as the contract declares it. */
export type SendInvoiceInput = { invoice: Invoice };

/** What `sendInvoice` answers; the route does not validate it. */
export const sendInvoiceOutputSchema = z.lazy(() => invoiceSentSchema);

/** What `sendInvoice` returns, as the contract declares it. */
export type SendInvoiceOutput = InvoiceSent;
```

The two schemas are rendered from the spec's types by the Zod resolver, and a
type it cannot render is a finding: a REST operation is never left unvalidated.
The two types are the spec's own type text, re-exported under a name the client
and the route can import. Emitting the text rather than inferring from the schema
keeps the type identical to the contract — a `z.infer` of an optional field is
`string | undefined`, which is not assignable to `field?: string` under
`exactOptionalPropertyTypes`. The input type is what the route hands the
implementation, so it is the parsed value, not a pre-parse one.

The output schema is generated but not applied: the route encodes the result
unvalidated, as every other call does.

The module is re-exported from `sdk/schemas.ts`, so a caller imports
`SendInvoiceInput`, not a `Parameters<…>` expression.

The client gets one builder per operation, in a module named after its contract:

```ts
export function sendInvoice(opts: SendInvoiceInput): Call<SendInvoiceOutput> {
    return call<SendInvoiceOutput>("sendInvoice", "POST", "/invoice/send", opts);
}
```

The builder names no contract and no context, so neither appears in the client's
types.

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

- **Per-operation context construction.** Every REST operation receives the
  `RequestContext` built for its request; a dependency another context would
  need is added to `createRequestContext`, not resolved per operation.
- **Validating the response.** The result schema is generated and exported, but
  the route encodes the result unvalidated, as with every other call.
- **Deleting an implementation the spec drops.** The generator reports the
  module and fails the run; deciding whether the code is still wanted is the
  author's.

## Gotchas

- **The scaffold's doc is a copy.** It carries the spec's description and
  `@throws` tags as they were when the file was created; later spec edits do not
  propagate.
- **The marker may stay after implementation.** It reads as provenance, not as a
  clean-up task; pruning is decided by the `NotImplemented` body, so implementing
  an operation without deleting that line is safe.
- **A scaffold reports itself.** Until the body is replaced the route answers
  `501 not-implemented`, which is visible to a caller and to a test rather than
  answering an empty success.
- **The parameter names are the spec's.** They are copied into the arrow
  function, so an unused context parameter is reported by the linter's
  unused-variable rule.
- **The scaffold's context is `unknown`.** It compiles, but `ctx` is unusable
  until the implementer narrows the type argument. Widening it past `RequestContext`
  makes the generated route fail to compile, which is the intended pressure.
- **A route without an input sends nothing.** A `POST` with no body decodes to
  `undefined`, which the generated `z.undefined()` accepts; the route ignores the
  argument entirely.
- **The client module is named after the contract.** Two contracts map to two
  modules, so an operation name must still be unique across the spec.
