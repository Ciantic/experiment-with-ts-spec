# Schema generation

`packages/backend/scripts/generate-postgres-schema.ts` turns the domain models in
`packages/spec/src/domain/` into Postgres DDL.

- `pnpm generate:schema` — writes `packages/backend/src/postgres/schema.sql`.
- `pnpm generate:schema --out <path>` — writes elsewhere. A missing directory is created.
- `pnpm generate:schema:stdout` — prints to stdout instead of writing.

The output file is committed. It is generated, so regenerate rather than editing
it by hand; nothing enforces that it stays in step with the spec.

The tags it consumes are defined in `docs/spec-annotations.md`.

## Type mapping

Names follow the table in
https://github.com/Ciantic/pg-unified-mapping, so the emitted keyword is the one
that library lists for the type. These are Postgres aliases (`int8` = `bigint`,
`decimal` = `numeric`, `float8` = `double precision`), not distinct types: the
server canonicalises them, and `information_schema.columns` reports the canonical
name back.

- `GUID`, `BrandedId<...>`, and any `<Entity>Id` type — `uuid`.
- `Decimal` — `decimal`, for every numeric value: money, counts, and rates.
- `Date` — `timestamptz`.
- `string`, `Email`, `Unit`, `Currency` — `text`.
- `boolean` — `boolean`.
- `boolean` — `boolean`.
- A union of string literals (such as `"draft" | "sent"`) — `text` plus a CHECK
  constraint listing the values.
- An open union (`Unit`, `Currency`, which end in `string & {}`) — plain `text`,
  no CHECK, because the value set is deliberately not closed.
- An entity type — a foreign key column, via `@relation`.
- An array of entities — not a column, via `@children`.

Unresolvable types are reported as diagnostics and no SQL is produced.

## Keys and relations

- A field named `id` is the primary key and is always `not null`.
- A field whose type is named `<Entity>Id` (other than `id`) is a foreign key to
  that entity's table, inline `references`.
- `@relation <Entity>` on an entity-typed field emits a `<field>Id uuid` column
  referencing that entity, nullable when the field is optional.
- `@children <Entity>` is skipped; the child table owns the foreign key.
- `@unique` adds a `unique` constraint.

Columns are named exactly as the fields, quoted camelCase, matching the
fragments in `packages/backend/src/postgres/formulas.ts`. There is no name mapping.

## Ordering

Tables are emitted so that referenced tables come first. A cycle is reported as
a diagnostic and the remaining tables are emitted in encounter order — the DDL
would then need manual reordering or deferred constraints.

## Triggers

Same-row `@computed storage=stored` fields become one `before insert or update`
trigger per table, assigning in interface field order. Order matters: on
`invoice_row` the assignments are `netAmount`, `taxAmount`, `totalAmount`, and
each reads the previous one, so Postgres would reject them as a generated column.

The expressions are plpgsql statements, so every reference to a column of the
row being written must be `NEW`-qualified. An unqualified `"quantity"` is a
plpgsql error (`column "quantity" does not exist`), not an implicit `NEW` lookup.
This only surfaced once the DDL was run against a real Postgres.

Cross-table aggregates cannot run as a before trigger on the parent, because the
child rows do not exist yet at insert. They are therefore `after insert or
update` and `after delete` triggers on the child table, which `update` the
parent with a fresh `sum`. The statements live in `invoiceFormulas` in
`packages/backend/src/postgres/formulas.ts` as `childNew` and `childOld`.

The invoice total is not part of that update. Writing `netAmount` and `taxAmount`
fires the invoice's own before-update trigger, which recomputes `totalAmount`.
So the two mechanisms chain, and the chain is load-bearing.

Known constraint: the aggregate fragments hardcode the foreign key column
`"invoiceId"`. A second child table aggregating into `invoice` would need its own
statements.

## Validation

Two test files:

- `packages/backend/scripts/generate-postgres-schema.test.ts` — the generator's
  behaviour, driven by self-contained in-memory fixtures. It does not read the real
  spec, so it stays valid as the domain changes. `generateSchema` takes
  `{ specGlob, formulasFile }` so a fixture can be generated from its own files.
- `packages/backend/src/postgres/schema.test.ts` — one check: the committed file
  executes in Postgres.

Nothing checks that `packages/backend/src/postgres/schema.sql` is up to date. It is a generated
artifact, and staleness is caught by remembering to run `pnpm generate:schema`,
not by a test. A drift test is the obvious way to enforce it if that becomes a
problem.

Execution subsumes the structural checks that were tempting to add (balanced
quotes, well-formed identifiers, foreign keys pointing at real tables, functions
existing before they are used), because Postgres rejects all of those at parse or
create time. Text assertions on the same properties can only fail where execution
already would.

None of these assert what the schema *means*. A trigger that computes the wrong
column, or an aggregate that sums the wrong thing, passes both — the SQL is
valid and the text is as generated. Behavioural tests were deliberately not added
yet, because they would be tightly coupled to the domain and would have to be
rewritten with every model change. When the model settles, a suite that exercises
triggers and constraints against PGlite is the missing layer.

## Type resolution

- A single string literal is a closed set of one, so it gets a CHECK.
- `(string & {})` arrives as a parenthesized type and is unwrapped before the
  intersection is examined. Without that, an open union such as
  `"hours" | (string & {})` is misread as closed and gets a CHECK over just the
  literal members.
- A field whose type is an entity must carry `@relation`; the referenced entity
  must itself be an interface in the spec.

Gotchas found by running the DDL:

- **PGlite parses `int8` to a JS number by default,** which silently loses
  precision above 2^53. The parsers in `packages/backend/src/postgres/pglite-setup.ts` map it to
  `bigint`. No spec field uses `bigint` now, so this only matters if one is added.
- **The fragments must be `NEW`-qualified** (see above). Running the DDL is what
  revealed this.
- **Foreign keys have no `ON DELETE` clause,** so a referenced row cannot be
  deleted rather than the reference being nulled or cascaded.
- **Computed columns are `not null` with no default,** so an insert must supply
  them; the before trigger overwrites the supplied value.

## Result mapping

The schema says what the columns are; the drivers also need to hand back the
right JavaScript types. Both are ported from
https://github.com/Ciantic/pg-unified-mapping.

- `packages/backend/src/postgres/pglite-setup.ts` — PGlite. `createPglite()` returns an
  instance configured with result parsers.
- `packages/backend/src/postgres/pg-setup.ts` — node-postgres. `createPgMapperTypes(pg)` returns the
  `types` option for `new pg.Client(...)` or `new pg.Pool(...)`.

The rules are the same in both:

- `int8` returns `bigint`. No spec field uses it at present.
- `date` and `timestamp` return strings, not `Date`. The spec models them with a
  `Date` type at the application boundary; the driver returning strings keeps the
  wire format explicit. Converting is the caller's job.
- `numeric` returns a string, so precision is not lost in a JS number.
- `bytea` returns `Uint8Array` rather than `Buffer`.

Gotchas:

- **`pg-setup.ts` does not import `pg`.** The module is taken as a parameter and
  typed structurally, so `pg` stays an optional dependency and nothing here needs
  it installed. Nothing exercises the mapping: it has no tests, and the
  structural `PgModule` type is unverified against the real driver. Passing a real
  `pg` instance would type-check it.
- **Everything numeric is `decimal`.** Amounts, quantities, and tax rates share
  one type, so the drivers return strings for all of them, matching the `Decimal`
  brand. Rounding to two decimals is in the formula (`round(..., 2)`), not in the
  column type, so a stored amount's scale is defined in one place.
- **Only the OIDs listed in each file are remapped.** Anything else delegates to
  the driver's own parser.
- **PGlite parsers are keyed by OID in a `ParserOptions` object**, whereas `pg`
  takes a `getTypeParser` replacement. That is why the two files do not share
  code.

## Deliberately not implemented

- **Views for `storage=derived`.** Accepted as a tag value, not emitted.
- **Migrations.** Only full `create` statements are produced; there is no diffing
  against an existing database.
- **Defaults and sequences.** `id` is `uuid not null` with no default, so the
  application supplies it.
- **Indexes beyond primary key, unique, and foreign key.**
- **`not null` on computed columns before the trigger runs.** The columns are
  declared `not null` and populated by a before trigger, so an insert that skips
  the trigger fails rather than defaulting.
- **Ownership and grants.**
- **Idempotent output.** The file is plain `create` statements with no
  `if not exists` and no `drop`, so re-applying it to an existing database
  fails. Use a fresh database.
