# Validation

`packages/validation/scripts/generate-zod-schemas.ts` turns the domain models in
`packages/spec/src/domain` into Zod schemas, written to `packages/validation/src`.
A schema is what validates a value at the boundary — an HTTP body, a job
payload — against the same annotations the database schema and the repositories
are generated from.

## Output

- `src/primitives.ts` — one schema per `@primitive` alias, from its `@zod` tag.
- `src/<entity>.ts` — one module per domain interface, exporting `<name>Schema`,
  `<name>PatchSchema`, and `<name>SelectSchema`.
- `src/queries/<entity>Queries.ts` — one module per entity a `@query` reads,
  exporting a `<name>Schema` per query alias.
- `src/queries/index.ts` — the barrel re-exporting every query module.
- `src/index.ts` — the barrel re-exporting the primitives, every entity, and the
  queries barrel.

```typescript
export const invoiceSchema = z.object({
    id: primitives.brandedIdSchema<"InvoiceId">(),
    number: z.string().optional(),
    customer: z.lazy(() => customerSchema).optional(),
    rows: z.array(z.lazy(() => invoiceRowSchema)).optional(),
    version: primitives.versionSchema.optional(),
});

/** A partial update: every field is optional except the key and the version. */
export const invoicePatchSchema = invoiceSchema.partial().required({
    id: true,
    version: true,
});
```

## How a field maps

| Spec field | Zod |
| --- | --- |
| `string`, `number`, `boolean`, `bigint` | `z.string()`, `z.number()`, … |
| `Date` | `z.date()` |
| `@primitive` alias | the alias's `@zod` expression, referenced through `primitives` |
| another type alias | resolved through its underlying type (`InvoiceId` → `BrandedId<"InvoiceId">`) |
| an entity (`@relation`, `@inlined`) | `z.lazy(() => <entity>Schema)` |
| `@children` array | `z.array(z.lazy(() => <entity>Schema))` |
| string-literal union | `z.enum([...])` |
| open union (`string & {}`) | `z.enum([...]).or(z.string())` |
| optional field | the expression gains `.optional()` |

The mapping reads annotations, not domain names. A new primitive is a spec-only
change: `primitives.ts` picks it up from its `@primitive` and `@zod` tags, and a
field referencing it resolves to the primitive's schema.

## Primitives and brands

A `@primitive` alias is rendered from its `@zod` tag verbatim. The tag is the
runtime counterpart of the alias's brand, so `moneySchema` carries the
`.brand<"Money">()` that makes a parsed value assignable to `Money` — the same
reason `docs/primitives.md` gives for the tag existing.

A **generic** primitive becomes a factory rather than a constant. `BrandedId`
declares `@zod z.uuid().brand<Name>()` over its type parameter, so the generator
emits:

```typescript
export function brandedIdSchema<Name extends string>() {
    return z.uuid().brand<Name>();
}
```

A field typed `InvoiceId` resolves through `InvoiceId = BrandedId<"InvoiceId">`
to `primitives.brandedIdSchema<"InvoiceId">()`, so the parsed value carries the
`"InvoiceId"` brand rather than a bare `string`.

## Patch schemas

`<name>PatchSchema` is the schema's `.partial()` with the key and every
`@version` field made required again. It mirrors the repository's patch contract
(`docs/repositories.md`): an update names the row and carries the optimistic-lock
precondition, and every other field is optional. It matches the repository
generator's rule — the key is the `id` field, the version is the `@version`
field — without hardcoding a column list.

## Query schemas

A `@query` alias declares a read's arguments (`docs/queries.md`). A read takes
one argument — its filters plus `select` — so the schema is that object with the
entity's select schema added as a field. The arguments resolve like an entity's
fields, with the same primitives, keywords, `Date` mapping, and `.optional()`
for a `?` field. One `<name>Schema` is emitted per alias: `@query Invoice many`
on `ListInvoices` yields `listInvoicesSchema` in
`src/queries/invoiceQueries.ts`, grouped by the entity the query reads.

`@in` is a backend operator annotation (`docs/spec-annotations.md`): the schema
sees only the argument's type, so `ids: InvoiceId[]` validates as
`z.array(…)` and the tag needs no handling here.

```typescript
export const getInvoiceSchema = z.strictObject({
    id: primitives.brandedIdSchema<"InvoiceId">(),
    select: invoiceSelectSchema,
});

export const listInvoicesSchema = z.strictObject({
    customerId: primitives.brandedIdSchema<"CustomerId">().optional(),
    select: invoiceSelectSchema,
});
```

The module is separate from the entities so a caller can validate a read without
pulling in a write schema, and `--out` still writes below the given directory.

### Select schemas

`select` is not a fixed shape: a caller picks any subset of fields and nests
into branches. So it is validated against a generated per-entity schema,
`<name>SelectSchema`, that mirrors `Selection<E>` in
`packages/spec/src/queries/selection.ts`:

```typescript
export const invoiceSelectSchema = z.lazy(() =>
    z.strictObject({
        id: z.literal(true).optional(),
        totalAmount: z.literal(true).optional(),
        customer: z.union([z.literal(true), z.lazy(() => customerSelectSchema)]).optional(),
        rows: z.union([z.literal(true), z.lazy(() => invoiceRowSelectSchema)]).optional(),
    }),
);
```

- A **scalar** field takes `true`.
- A **branch** — an entity reference or a child collection — takes `true` (its
  own scalars) or a nested select.
- A field that is neither is **rejected**: the object is `z.strictObject`, so an
  unknown key fails rather than being stripped. That is what makes the schema a
  validator rather than a hint.
- `z.lazy` defers every reference, so a self- or mutually-recursive entity graph
  is expressible.

The branch/scalar split comes from the field's **type**, not its tag: a type
that resolves to an interface is a branch. The `@relation` / `@children` /
`@inlined` tags only say how the branch is stored (`docs/queries.md`); selection
is about the value shape, so it follows the type.

Select schemas are generated for **every** entity, not only those a `@query`
reads, because a select nests into targets that may have no read of their own.
They live in the entity module next to `<name>Schema`, so `src/index.ts` already
re-exports them. A query's args schema references the one for the entity it
reads, so validating a read validates its selection too.

## Annotations

The generator reads only type-level annotations: `@primitive`, `@zod`, `@query`,
and the `@version` field tag. It never names a domain type. The parsing and tag
vocabulary live in `packages/spec/scripts/spec-model.ts`; a new domain type is a
spec-only change unless it introduces a type the mapper cannot express, which is
reported as a diagnostic.

## Commands

- `pnpm generate:validation` — writes `packages/validation/src`.
- `pnpm generate:validation --out <path>` — writes elsewhere. A missing directory is created.
- `pnpm run generate` — runs it after the schema and repository generators.

## Validation

- `packages/validation/scripts/generate-zod-schemas.test.ts` drives the mapper
  and the renderer with self-contained fixtures, never the real spec. It also
  evaluates `primitives.ts` against Zod to prove the emitted schemas parse.
- `pnpm run typecheck` compiles the generated `src`, so a schema that does not
  typecheck fails the build.

Nothing checks that the committed `src` is up to date. It is a generated
artifact; staleness is caught by running the generator, not by a test.

## Deliberately not implemented

- **Stripping `@generated` fields.** `InvoiceSchema` mirrors the interface as
  written, so `id` and the timestamps are required exactly as the type declares
  them. A create-payload schema that omits system-assigned fields is a separate,
  policy-bearing decision.
- **Coercion.** `Date` maps to `z.date()`, not `z.coerce.date()`, so a JSON
  string does not parse as a date. Coercion is a boundary decision, not a
  property of the type.
- **A type-parity assertion.** Nothing asserts that `z.infer<typeof
  invoiceSchema>` is assignable to `Invoice`. The two are generated from the same
  annotations, but the compiler is not asked to prove it.
