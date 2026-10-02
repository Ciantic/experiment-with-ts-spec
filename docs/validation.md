# Validation

`packages/backend/scripts/generate-zod-schemas.ts` turns the domain models in
`packages/spec/src/domain` into Zod schemas, written to
`packages/backend/src/validation`. A schema is what validates a value at the
boundary — an HTTP body, a job payload — against the same annotations the
database schema and the repositories are generated from.

## Output

- `packages/backend/src/validation/primitives.ts` — one schema per `@primitive`
  alias, from its `@zod` tag.
- `packages/backend/src/validation/<entity>.ts` — one module per domain interface,
  exporting `<name>Schema`, `<name>PatchSchema`, and `<name>SelectSchema`.
- `packages/backend/src/validation/queries/query<Entity>.ts` — one module per
  entity, exporting `<name>Schema` for its `query` read.
- `packages/backend/src/validation/queries/index.ts` — the barrel re-exporting
  every query module.
- `packages/backend/src/validation/index.ts` — the barrel re-exporting the
  primitives, every entity, and the queries barrel.

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

Every entity gets a generated `query` read (`docs/queries.md`), so every entity
gets a `query` args schema. A read takes one argument — its filters plus `select`
— so the schema is that object with the entity's select schema added as a field.
The filters come from the entity's `@queryfilter` fields, resolved like any other
field (the same primitives, keywords, and `Date` mapping) and always validated as
a set: `z.array(…)`. The schema is named after the read: `Invoice` yields
`queryInvoiceSchema` in
`packages/backend/src/validation/queries/queryInvoice.ts`.

```typescript
export const queryInvoiceSchema = z.strictObject({
    id: z.array(primitives.brandedIdSchema<"InvoiceId">()).optional(),
    select: invoiceSelectSchema,
});
```

Every filter is optional, which mirrors the generated `Filters<…>` type and lets
`queryInvoiceSchema` validate a `query` that names none.

The module is separate from the entities so a caller can validate a read without
pulling in a write schema, and `--out` still writes below the given directory.

### Select schemas

`select` is not a fixed shape: a caller picks any subset of fields and nests
into branches. So it is validated against a generated per-entity schema,
`<name>SelectSchema`, that mirrors `Selection<E>` in
`packages/spec/src/selection.ts`:

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

Select schemas are generated for **every** entity, because a select nests into
targets that may have no filters of their own. They live in the entity module
next to `<name>Schema`, so
`packages/backend/src/validation/index.ts` already re-exports them. A query's
args schema references the one for the entity it reads, so validating a read
validates its selection too.

## Annotations

The generator reads only annotations: `@primitive`, `@zod`, `@version`, and
`@queryfilter` (which `spec-model.ts` defaults on `id`). It never names a domain type. The parsing and tag
vocabulary live in `packages/spec/scripts/spec-model.ts`; a new domain type is a
spec-only change unless it introduces a type the mapper cannot express, which is
reported as a diagnostic.

## Commands

- `pnpm generate:validation` — writes `packages/backend/src/validation`.
- `pnpm generate:validation --out <path>` — writes elsewhere. A missing directory is created.
- `pnpm run generate` — runs it after the schema, repository, and query generators.

## Validation

- `packages/backend/scripts/generate-zod-schemas.test.ts` drives the mapper
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
