# Validation

`packages/validation/scripts/generate-zod-schemas.ts` turns the domain models in
`packages/spec/src/domain` into Zod schemas and the matching write types, written
to `packages/validation/src`. The generator lives in the package that owns its
artifact, so `pnpm --filter validation run generate:validation` regenerates the
schemas without the backend. A schema is what validates a value at the boundary
— an HTTP body, a job payload — against the same annotations the database schema
and the repositories are generated from; the write types are what a caller passes
in process. Because both live in one module, the backend repositories, the REST
API, the generated client, and (eventually) the frontend share one definition of
"the fields a create writes" and "the fields a patch writes".

## Output

- `packages/validation/src/primitives.ts` — one schema per `@primitive` alias,
  from its `@zod` tag.
- `packages/validation/src/<entity>.ts` — one module per domain interface,
  exporting `<name>Schema`, `<name>PatchSchema`, `<name>InsertSchema`,
  `<name>PrimaryKeySchema`, and the matching `<Entity>Patch`, `<Entity>Insert`,
  and `<Entity>PrimaryKey` types.
- `packages/validation/src/queries/query<Entity>.ts` — one module per entity,
  exporting `query<Entity>SelectSchema` and `query<Entity>Schema` for its `query`
  read.
- `packages/validation/src/queries/index.ts` — the barrel re-exporting every
  query module.
- `packages/validation/src/index.ts` — the barrel re-exporting the primitives,
  every entity, and the queries barrel.

The package is consumed as TypeScript through its `exports` map, like every other
package here. `packages/backend` and `packages/sdk` depend on it: the repositories
take `<Entity>Patch` / `<Entity>Insert` from it, the route table validates with
its schemas, and the client imports its write types type-only, so `zod` never
enters the client runtime.

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

/** A partial update: every field is optional except the key and the version. */
export type InvoicePatch = Omit<Partial<Invoice>, "customer" | "rows"> & Required<Pick<Invoice, "id" | "version">>;
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

`<name>PatchSchema` is the insert shape with every field optional and the key
and version required again. A patch writes the same columns a create does, plus
the version that carries the optimistic-lock precondition, and nothing else —
which is what the repository's patch contract says (`docs/repositories.md`).

```typescript
export const invoicePatchSchema = invoiceSchema
    .omit({
        customer: true,
        seller: true,
        netAmount: true,
        taxAmount: true,
        totalAmount: true,
        rows: true,
        createdAt: true,
        updatedAt: true,
    })
    .partial()
    .required({
        id: true,
        version: true,
    })
    .strict();
```

The omit list is a create's, less the version. That one exception is the whole
difference: a create must not carry the precondition, a patch must. So a patch
rejects the same branches, clock fields, and derivable values a create does, and
`.strict()` turns a key the update would silently ignore into a 400.

The list is `omittedFromPatch` (`packages/spec/scripts/spec-model.ts`), and the
`<Entity>Patch` type is rendered from it into the same module, so the repository
type taking it, the client sending it, and the wire schema accepting it all
permit exactly the same fields. A nullable `@computed` value is on the
list because its mechanism fills it in later, and a `@pgVirtual`
value is on it whether nullable or not because Postgres refuses the write: the
update does not name the column, so accepting one would be accepting a field that
does nothing (`docs/repositories.md`). A `@pgDefault` column is not on the list: a
patch may override a default, exactly as a create may.

## Insert schemas

`<name>InsertSchema` is the schema's `.omit()` of everything a create does not
write, made `.strict()`. It mirrors the repository's insert contract
(`docs/repositories.md`): a `create` writes the columns the database does not
own, and a key the schema rejects is a 400 rather than a field that is silently
dropped on the way to the SQL.

```typescript
export const invoiceInsertSchema = invoiceSchema
    .omit({
        customer: true,
        seller: true,
        netAmount: true,
        taxAmount: true,
        totalAmount: true,
        rows: true,
        createdAt: true,
        updatedAt: true,
        version: true,
    })
    .strict();
```

A field is omitted when the database owns it, from either annotation:

- **A branch** — a `@relation` or a `@children` collection — is not a column, so
  a create cannot write it. `customer`, `seller`, and `rows` are omitted.
- **A clock field, a virtual generated column, and a defaulted `@version`** are
  the database's own on insert: the two timestamps carry `default now()`,
  `@pgVirtual` is generated always, and a version's default *is* its first
  revision.
- **A stored computation** is left to its mechanism to derive, but only while the
  column is optional. A required one has no default and no nullable column, so the
  insert has to carry it: `InvoiceSentRow.netAmount` and its siblings stay, while
  `Invoice.netAmount` goes. Omitting a required one is a `not null` violation,
  not a default.

A `@pgDefault` column is deliberately absent from the omit list. A create may
supply it or leave it out; an omitted one sends the `default` keyword, so the
database fills that row. A *required* defaulted field is relaxed with
`.partial()` so the schema agrees that omitting it is allowed.

An `@inlined` field is the exception: it is a snapshot of another entity, so a
create still writes it, nested as that entity's own insert schema. `InvoiceSent`
therefore keeps `customer` and `seller`, each validated as `customerInsertSchema`
— `docs/timestamps.md` explains why the snapshot carries the target's own audit
columns.

The repository's `create` takes the same field set, as the `<Entity>Insert` type
imported from this package, and its `insert` names exactly those columns
(`docs/repositories.md`). So the type a caller passes, the schema that validates
it, and the statement that runs all carry one set of fields, and a field added to
the spec narrows all three at once.

## Primary key schema and type

`<name>PrimaryKeySchema` is the entity schema projected to the fields tagged
`@primaryKey`, made `.strict()` like a patch or an insert, so a field the write
would ignore is a 400. `<Entity>PrimaryKey` is the matching type:

```typescript
/** The key of one stored row: the shape a delete or other by-key write sends. */
export const invoicePrimaryKeySchema = invoiceSchema.pick({ id: true }).strict();

/** The key of one stored row: what a delete or other by-key write addresses. */
export type InvoicePrimaryKey = Pick<Invoice, "id">;
```

A composite key projects every one of its columns, and requires all of them to
address a row:

```typescript
export const translationPrimaryKeySchema = translationSchema.pick({ lang: true, key: true }).strict();
export type TranslationPrimaryKey = Pick<Translation, "lang" | "key">;
```

A write that only addresses a stored row names this pair rather than the whole
entity, so a caller cannot pass a field the statement would silently ignore. The
repository's `delete` takes `InvoicePrimaryKey[]`, and the route that serves it
validates with `z.array(invoicePrimaryKeySchema)` (`docs/repositories.md`). An
interface with no `@primaryKey` field gets neither; the backend generator rejects
it as a table before anything consumes it.

## Query schemas

Every entity gets a generated `query` read (`docs/queries.md`), so every entity
gets a `query` args schema. A read takes one argument — its filters, its
ordering, its comparisons, and `select` — so the schema is that object with the
entity's select schema added as a field. The filters come from the entity's
`@queryFilter` fields, resolved like any other field (the same primitives,
keywords, and `Date` mapping) and always validated as a set: `z.array(…)`. The
ordering keys come from the entity's `@queryOrderBy` fields, and the comparison
fields and their operators from `@queryWhere`. The schema is named after the read:
`Invoice` yields `queryInvoiceSchema` in
`packages/validation/src/queries/queryInvoice.ts`.

```typescript
export const queryInvoiceSchema = z.strictObject({
    filter: z.strictObject({
        id: z.array(primitives.brandedIdSchema<"InvoiceId">()).optional(),
    }).optional(),
    order: z.array(
        z.tuple([z.enum(["createdAt", "updatedAt"]), z.enum(["asc", "desc"])]),
    ).optional(),
    where: z.strictObject({
        issueDate: z.strictObject({
            gte: z.date().optional(),
            lte: z.date().optional(),
        }).optional(),
    }).optional(),
    limit: z.number().int().positive().optional(),
    offset: z.number().int().nonnegative().optional(),
    select: queryInvoiceSelectSchema,
});
```

Every filter is optional, which mirrors the generated `Filters<…>` type and lets
`queryInvoiceSchema` validate a `query` that names none. The filter is its own
`z.strictObject`, so a flat filter field or an unknown filter key fails rather
than being stripped, and a data field named `select` cannot collide with the
projection. Each `order` clause is a `[field, direction]` tuple whose field is
whitelisted (`z.enum`), so an unknown sort key is a 400 rather than a `500` from
the resolver. Each `where` field is a `z.strictObject` of **only** the operators
`@queryWhere` declared, so a comparison the spec does not allow is a 400 too; the
field's own schema types each operator's value. `limit` is a positive integer
and `offset` a non-negative integer, so a bad page is a 400. An entity with no
`@queryOrderBy` field gets no `order` key and an entity with no `@queryWhere` field no
`where` key; every entity gets `limit` and `offset`.

The module is separate from the entities so a caller can validate a read without
pulling in a write schema, and `--out` still writes below the given directory.

### Select schemas

`select` is not a fixed shape: a caller picks any subset of fields and nests
into branches. So it is validated against a generated per-query schema,
`query<name>SelectSchema`, that mirrors `Selection<E>` in
`packages/spec/src/selection.ts`:

```typescript
export const queryInvoiceSelectSchema = z.lazy(() =>
    z.strictObject({
        id: z.literal(true).optional(),
        totalAmount: z.literal(true).optional(),
        customer: z.union([z.literal(true), z.lazy(() => queryCustomerSelectSchema)]).optional(),
        rows: z.union([z.literal(true), z.lazy(() => queryInvoiceRowSelectSchema)]).optional(),
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
targets that may have no filters of their own. They live in each entity's query
module next to `query<Entity>Schema`, and are re-exported by the queries barrel.
A query's args schema references its query-specific select schema, so validating
a read validates its selection too.

## Annotations

The generator reads only annotations: `@primitive`, `@zod`, `@version`, and
`@queryFilter` (which `spec-model.ts` defaults on every `@primaryKey` field). It never names a domain type. The parsing and tag
vocabulary live in `packages/spec/scripts/spec-model.ts`; a new domain type is a
spec-only change unless it introduces a type the mapper cannot express, which is
reported as a diagnostic.

## Commands

- `pnpm generate:validation` — writes `packages/validation/src`. It runs in the
  `validation` package, which owns the generator (`scripts/generate-zod-schemas.ts`).
- `pnpm generate:validation --out <path>` — writes elsewhere. A missing directory is created.
- `pnpm run generate` — runs it after the schema, repository, and query generators.

## Validation

- `packages/validation/scripts/generate-zod-schemas.test.ts` drives the mapper
  and the renderer with self-contained fixtures, never the real spec. It also
  evaluates `primitives.ts` against Zod to prove the emitted schemas parse.
- `pnpm run typecheck` compiles the generated `src`, so a schema that does not
  typecheck fails the build.

Nothing checks that the committed `src` is up to date. It is a generated
artifact; staleness is caught by running the generator, not by a test.

## Deliberately not implemented

- **Stripping a system-assigned field from a create.** `InvoiceSchema` mirrors
  the interface as written, so `id` and the timestamps are required exactly as
  the type declares them. A create-payload schema that omits an
  application-assigned field is a separate, policy-bearing decision.
- **Coercion.** `Date` maps to `z.date()`, not `z.coerce.date()`, so a JSON
  string does not parse as a date. Coercion is a boundary decision, not a
  property of the type.
- **A type-parity assertion.** Nothing asserts that `z.infer<typeof
  invoiceSchema>` is assignable to `Invoice`. The two are generated from the same
  annotations, but the compiler is not asked to prove it. The write types are
  built from the spec type and the omit lists, not `z.infer`, so a patch or
  insert keeps the entity's own branded primitives and the repository can read a
  nested snapshot's audit columns.
