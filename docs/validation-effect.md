# Validation (Effect v4)

`packages/backend-effect/scripts/generate-schemas.ts` turns the domain models in
`packages/spec/src/domain` into `effect/schema` schemas, written to
`packages/backend-effect/src/validation`. It is the Effect v4 counterpart of
`packages/backend/scripts/generate-zod-schemas.ts` (`docs/validation.md`), runs
alongside it, and is driven by the same annotations. A schema is what validates a
value at a boundary — an HTTP body, a job payload — against the same annotations
the database schema and the repositories are generated from.

## Output

- `src/validation/primitives.ts` — one schema per `@primitive` alias, from its
  `@effect` tag.
- `src/validation/<entity>.ts` — one module per domain interface, exporting
  `<name>Schema`, `<name>PatchSchema`, and `<name>SelectSchema`.
- `src/validation/queries/<entity>Queries.ts` — one module per entity, exporting
  `list<Entity>Schema` and `get<Entity>Schema`.
- `src/validation/queries/index.ts` — the barrel re-exporting every query module.
- `src/validation/index.ts` — the barrel re-exporting the primitives, every
  entity, and the queries barrel.

```typescript
import { Schema } from "effect";

export const invoiceSchema = Schema.Struct({
    id: primitives.brandedIdSchema("InvoiceId"),
    number: Schema.optionalKey(Schema.String),
    customer: Schema.optionalKey(Schema.suspend(() => customerSchema)),
    rows: Schema.optionalKey(Schema.Array(Schema.suspend(() => invoiceRowSchema))),
    version: Schema.optionalKey(primitives.versionSchema),
});

/** A partial update: every field is optional except the key and the version. */
export const invoicePatchSchema = Schema.Struct({
    id: primitives.brandedIdSchema("InvoiceId"),
    number: Schema.optionalKey(Schema.String),
    /* … */
    version: primitives.versionSchema,
});
```

## How a field maps

| Spec field | `effect/schema` |
| --- | --- |
| `string`, `number`, `boolean`, `bigint` | `Schema.String`, `Schema.Number`, … |
| `Date` | `Schema.Date` |
| `@primitive` alias | the alias's `@effect` expression, referenced through `primitives` |
| another type alias | resolved through its underlying type (`InvoiceId` → `BrandedId<"InvoiceId">`) |
| an entity (`@relation`, `@inlined`) | `Schema.suspend(() => <entity>Schema)` |
| `@children` array | `Schema.Array(Schema.suspend(() => <entity>Schema))` |
| string-literal union | `Schema.Literals([...])` |
| open union (`string & {}`) | `Schema.Union([Schema.Literals([...]), Schema.String])` |
| optional field | `Schema.optionalKey(<expression>)` |

The mapping reads annotations, not domain names. A new primitive is a spec-only
change: `primitives.ts` picks it up from its `@primitive` and `@effect` tags, and
a field referencing it resolves to the primitive's schema.

## Differences from the Zod generator

`effect/schema` is not a drop-in for Zod, so a few things are spelled
differently. They are behaviour-affecting; a reader moving between the two
generators should know them.

- **Strictness is a decode option, not a schema property.** `Schema.Struct`
  leaves unmodeled keys open by default and strips them, where `z.strictObject`
  rejected them at parse time. To reject an unknown key — the property that makes
  `select` a validator rather than a hint — decode with
  `{ onExcessProperty: "error" }`; the Effect router applies it at the HTTP
  boundary. The generated `select` schemas are still `Schema.Struct`, so the
  policy is applied uniformly by the decoder rather than encoded per field.
- **Optional is `Schema.optionalKey`.** The spec's `field?: T` means absent, not
  `undefined`, and the repo enables `exactOptionalPropertyTypes`;
  `optionalKey` is the exact match. `Schema.optional` would widen to
  `T | undefined`.
- **A generic primitive takes its type argument as a value.** Effect's
  `Schema.brand` takes the brand *identifier as a value*, so a generic primitive
  declares a value parameter alongside its type parameter and brands from it:
  `brandedIdSchema<Name>(name: Name)`. The decoded type is then
  `string & Brand.Brand<Name>`, the Effect arm of the spec's `Brand<Name>` — the
  cast `name as never` is only to satisfy the single-brand-key constraint. See
  `docs/primitives.md`.
- **The patch schema is rendered explicitly.** There is no `.partial()` in
  `effect/schema`, so `<name>PatchSchema` is a second `Schema.Struct` with every
  field wrapped in `Schema.optionalKey` except the key and every `@version`
  field — the same rule the Zod generator reaches with
  `.partial().required({...})`.
- **`get` uses `Schema.makeFilter`.** `Schema.refine` requires a type predicate;
  a plain boolean check is `Schema.check(Schema.makeFilter((value) => …, { message }))`.

## Primitives

A `@primitive` alias is rendered from its `@effect` tag verbatim. A **generic**
primitive becomes a factory whose type parameters are also value parameters, so
`BrandedId` yields:

```typescript
export function brandedIdSchema<Name extends string>(name: Name) {
    return Schema.String.check(Schema.isUUID()).pipe(Schema.brand<Name>(name as never));
}
```

A field typed `InvoiceId` resolves through `InvoiceId = BrandedId<"InvoiceId">`
to `primitives.brandedIdSchema("InvoiceId")`.

## Patch schemas

`<name>PatchSchema` mirrors the repository's patch contract
(`docs/repositories.md`): an update names the row and carries the optimistic-lock
precondition, and every other field is optional. The rule — the key is the `id`
field, the version is the `@version` field — is read from the spec, not
hardcoded.

## Query schemas

Every entity gets a generated `list` read, and every entity with a `@queryfilter`
field also gets a `get` (`docs/queries.md`) — which is every entity, since `id`
is a filter by default. A read takes one argument — its filters plus `select` —
so the schema is that object with the entity's select schema added as a field,
and the filters come from the entity's `@queryfilter` fields, always validated as
a set: `Schema.Array(…)`.

```typescript
export const listInvoiceSchema = Schema.Struct({
    id: Schema.optionalKey(Schema.Array(primitives.brandedIdSchema("InvoiceId"))),
    select: invoiceSelectSchema,
});

/** The same filters, with at least one of them named. */
export const getInvoiceSchema = listInvoiceSchema.pipe(
    Schema.check(
        Schema.makeFilter((value) => value.id !== undefined, { message: "getInvoice needs at least one filter" }),
    ),
);
```

`get` is built by refining the `list` schema, so the two cannot drift apart, and
an entity with no filter gets only the `list` schema.

### Select schemas

`select` is not a fixed shape: a caller picks any subset of fields and nests into
branches. So it is validated against a generated per-entity schema,
`<name>SelectSchema`, that mirrors `Selection<E>` in
`packages/spec/src/selection.ts`:

```typescript
export const invoiceSelectSchema = Schema.suspend(() =>
    Schema.Struct({
        id: Schema.optionalKey(Schema.Literal(true)),
        totalAmount: Schema.optionalKey(Schema.Literal(true)),
        customer: Schema.optionalKey(Schema.Union([Schema.Literal(true), Schema.suspend(() => customerSelectSchema)])),
        rows: Schema.optionalKey(Schema.Union([Schema.Literal(true), Schema.suspend(() => invoiceRowSelectSchema)])),
    }),
);
```

- A **scalar** field takes `true`.
- A **branch** — an entity reference or a child collection — takes `true` (its
  own scalars) or a nested select.
- `Schema.suspend` defers every reference, so a self- or mutually-recursive entity
  graph is expressible.
- An unknown key is rejected only when decoded with
  `{ onExcessProperty: "error" }`; see the differences above.

The branch/scalar split comes from the field's **type**, not its tag: a type
that resolves to an interface is a branch. The `@relation` / `@children` /
`@inlined` tags only say how the branch is stored (`docs/queries.md`); selection
is about the value shape, so it follows the type.

Select schemas are generated for **every** entity, because a select nests into
targets that may have no filters of their own.

## Annotations

The generator reads only annotations: `@primitive`, `@effect`, `@version`, and
`@queryfilter` (which `spec-model.ts` defaults on `id`). It never names a domain
type. The parsing and tag vocabulary live in
`packages/spec/scripts/spec-model.ts`; a new domain type is a spec-only change
unless it introduces a type the mapper cannot express, which is reported as a
diagnostic.

## Commands

- `pnpm generate:effect:validation` — writes
  `packages/backend-effect/src/validation`.
- `pnpm --filter backend-effect run generate:validation --out <path>` — writes
  elsewhere. A missing directory is created.
- `pnpm generate:effect` — runs it after the schema generator.

## Validation

- `packages/backend-effect/scripts/generate-schemas.test.ts` drives the mapper
  and the renderer with self-contained fixtures, never the real spec. It also
  evaluates the generated modules against `effect/schema` to prove they parse.
- `pnpm run typecheck` compiles the generated `src`, so a schema that does not
  typecheck fails the build.

Nothing checks that the committed `src` is up to date. It is a generated
artifact; staleness is caught by running the generator, not by a test.

## Deliberately not implemented

The same policies `docs/validation.md` records apply here: `@generated` fields
are not stripped, `Date` does not coerce from a string, and no test asserts that
`Schema.Schema.Type<typeof invoiceSchema>` is assignable to `Invoice`.
