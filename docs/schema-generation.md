# Schema generation

`packages/backend/scripts/generate-postgres-schema.ts` turns the domain models in
`packages/spec/src/domain/` into Postgres DDL.

The spec is parsed by `packages/spec/scripts/spec-model.ts`; the Postgres table
model is built by `packages/backend/scripts/postgres-model.ts`, which both this
generator and the repository generator consume. Only the rendering differs; see
`docs/repositories.md`.

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

Named spec types are mapped by the `@pgtype` tag their alias declares, so the
mapping lives in `packages/spec/src/primitives/`, not in the generator. Adding a
primitive is a spec-only change. The generator hardcodes only the TypeScript
built-ins:

- The keyword types `string` → `text`, `number` → `float8`, `boolean` →
  `boolean`, `bigint` → `int8`.
- `Date` (the built-in) → `timestamptz`.

Everything else resolves through the alias tree:

- A `@primitive` alias (`GUID`, `Decimal`, `Money`, `Version`, and so on) → the
  type its `@pgtype` names.
- `BrandedId<...>` and any `<Entity>Id` alias → `uuid`.
- A union of string literals (such as `"draft" | "sent"`) → `text` plus a CHECK
  constraint listing the values.
- An open union (`Unit`, `Currency`, which end in `string & {}`) → plain `text`,
  no CHECK, because the value set is deliberately not closed.
- An entity type → not a column; `@relation` navigates through the field tagged
  `@foreignKey`.
- An array of entities → not a column, via `@children`.

Unresolvable types are reported as diagnostics and no SQL is produced.

## Keys and relations

- `@primaryKey` marks a column of the table's key; the column is always `not
  null`. At least one per interface, and a field without the tag is not a key
  however it is named. Several key fields emit one `primary key (…)` constraint
  listing the columns in interface declaration order.
- `@foreignKey <Entity>` adds an inline `references` to that entity's table. The
  column type and the referenced column come from `<Entity>`'s own `@primaryKey`
  field, so the field's declared type is documentation and may be an alias this
  model cannot resolve. A single column cannot carry a composite key, so a
  `@foreignKey` naming an entity with one is a diagnostic.
- `@relation` on an entity-typed field adds no column of its own. It navigates
  through the `@foreignKey` field pointing at its table; that field's optionality
  sets the nullability. A `@relation` with no such field, or more than one
  candidate, is a diagnostic.
- `@children` on an array field is skipped; the child table owns the foreign key.
- `@unique` adds a `unique` constraint.
- `@pgdefault <expression>` appends `default <expression>`. The column is `not null`
  even when the field is optional. The repository generators name the column in
  their statements, and a row that omits it sends the `default` keyword, so the
  database fills that row. It may accompany `@computed`, where the default
  applies to the insert path and the trigger to every write. A defaulted
  `@version` field is the one exception: it is left out of the insert.
- `@createdAt`/`@updatedAt` append `default now()`; see `docs/timestamps.md`.
- `@computed @pgvirtual <expression>` appends
  `generated always as (<expression>) virtual`. The column is never written by
  the repository.

Columns are named exactly as the fields, quoted camelCase, matching the
expressions in the spec tags. There is no name mapping.

## Ordering

Tables are emitted so that referenced tables come first. A cycle is reported as
a diagnostic and the remaining tables are emitted in encounter order — the DDL
would then need manual reordering or deferred constraints.

## Triggers

`@computed @pgtrigger` fields become one `before insert or update` trigger per
table, assigning in interface field order. `@updatedAt` contributes its
`NEW."updatedAt" := now();` to the same trigger, after the fields. Order matters:
on `invoice_row` the assignments are `netAmount`, `taxAmount`, `totalAmount`, and
each reads the previous one, so they cannot be virtual columns.

The statements are plpgsql, so every reference to a column of the row being
written must be `NEW`-qualified. An unqualified `"quantity"` is a plpgsql error
(`column "quantity" does not exist`), not an implicit `NEW` lookup. A virtual
column's expression is the opposite: it is a SQL expression, so it must *not* be
`NEW`-qualified, and the linter does not check which form a field used.

A `@version` column gets its own `before update` trigger, separate from the
`_compute` trigger: it raises on a version mismatch and increments the column.
It is `before update` only, since there is no `OLD` on insert, and it fires after
`_compute` (Postgres orders same-timing triggers by name). See
`docs/versioning.md`.

Cross-table aggregates cannot run as a before trigger on the parent, because the
child rows do not exist yet at insert. They are therefore `after insert or
update` and `after delete` triggers on the child table, which `update` the
parent with a fresh `sum`. An `@pgrollup` statement is written once with `NEW.`;
the generator emits the `after delete` variant by substituting `OLD.`, and
attaches it to every child table whose foreign key points at the parent.

The invoice total is not part of that update. It is a virtual generated column
over `"netAmount" + "taxAmount"`, so it recomputes on read. The rollup's `update`
does fire the invoice's before-update trigger, which refreshes `updatedAt`; the
two mechanisms chain, and the chain is load-bearing for the clock.

Known constraint: the aggregate statements hardcode the foreign key column
`"invoiceId"`. A second child table with a different key column would need its
own statement, which is why `@pgrollup` is written per parent field rather than
shared by name.

## Validation

Two test files:

- `packages/backend/scripts/generate-postgres-schema.test.ts` — the generator's
  behaviour, driven by self-contained in-memory fixtures. It does not read the real
  spec, so it stays valid as the domain changes. `generateSchema` takes
  `{ specGlob, aliasGlob }` so a fixture can be generated from its own files.
- `packages/backend/src/postgres/schema.test.ts` — one check: the committed file
  executes in Postgres.

Nothing checks that `packages/backend/src/postgres/schema.sql` is up to date. It is a generated
artifact, and staleness is caught by remembering to run `pnpm generate:schema`,
not by a test. A drift test is the obvious way to enforce it if that becomes a
problem.

Execution subsumes the structural checks (balanced quotes, well-formed
identifiers, foreign keys pointing at real tables, functions existing before they
are used), because Postgres rejects all of those at parse or create time. Text
assertions on the same properties can only fail where execution already would.

None of these assert what the schema *means*. A trigger that computes the wrong
column, or an aggregate that sums the wrong thing, passes both — the SQL is
valid and the text is as generated. Behavioural tests are deliberately absent:
they would be tightly coupled to the domain and would have to be rewritten with
every model change. When the model settles, a suite that exercises triggers and
constraints against PGlite is the missing layer.

## Type resolution

- A single string literal is a closed set of one, so it gets a CHECK.
- `(string & {})` arrives as a parenthesized type and is unwrapped before the
  intersection is examined. Without that, an open union such as
  `"hours" | (string & {})` is misread as closed and gets a CHECK over just the
  literal members.
- A field whose type is an entity must carry `@relation`; the referenced entity
  must itself be an interface in the spec, and the interface must declare a
  `@foreignKey` field pointing at it.

Gotchas found by running the DDL:

- **PGlite parses `int8` to a JS number by default,** which silently loses
  precision above 2^53. The parsers in `packages/backend/src/postgres/pglite-setup.ts` map it to
  `bigint`. No spec field uses `bigint` now, so this only matters if one is added.
- **The fragments must be `NEW`-qualified** (see above). Running the DDL is what
  revealed this.
- **Foreign keys have no `ON DELETE` clause,** so a referenced row cannot be
  deleted rather than the reference being nulled or cascaded.
- **Computed columns follow the field's optionality, not the computation.** A
  required one is `not null` with no default, so an insert must supply it and the
  before trigger then overwrites it. An optional one is nullable, so the trigger
  fills it from a `null` and an insert may leave it out.

## Result mapping

The schema says what the columns are; the drivers also need to hand back the
right JavaScript types. Both are ported from
https://github.com/Ciantic/pg-unified-mapping.

- `packages/backend/src/postgres/pglite-setup.ts` — PGlite. `createPglite()` returns an
  instance configured with result parsers.
- `packages/backend/src/postgres/pg-setup.ts` — node-postgres. `createPgMapperTypes(pg)` returns the
  `types` option for `new pg.Client(...)`, and `createPgPool(pg, config)` builds a
  `Pool` with that option applied.

The rules are the same in both:

- `int8` returns `bigint`. No spec field uses it at present.
- `date` and `timestamp` return strings, not `Date`. The spec models them with a
  `Date` type at the application boundary; the driver returning strings keeps the
  wire format explicit. Converting is the caller's job.
- `numeric` returns a string, so precision is not lost in a JS number.
- `bytea` returns `Uint8Array` rather than `Buffer`.

Gotchas:

- **`pg-setup.ts` does not import `pg` at runtime.** The module is taken as a
  parameter and typed structurally, and the `pg` types it names are type-only, so
  `pg` stays a development dependency. A test passes the real module, so the
  mapping is exercised against the driver rather than described.
- **The installed `pg` types are behind the driver on one member.** `@types/pg`
  still describes `types.arrayParser` as a callable, while the runtime exports
  `{ create }`, which is what the mapper reads. The test asserts the runtime
  shape and casts at that one seam; the rest of `PgModule` is checked by
  assignment.
- **Everything numeric is `decimal`.** Amounts, quantities, and tax rates share
  one type, so the drivers return strings for all of them, matching the `Decimal`
  brand. Rounding to two decimals is in the expression (`round(..., 2)`), not in the
  column type, so a stored amount's scale is defined in one place.
- **Only the OIDs listed in each file are remapped.** Anything else delegates to
  the driver's own parser.
- **PGlite parsers are keyed by OID in a `ParserOptions` object**, whereas `pg`
  takes a `getTypeParser` replacement. That is why the two files do not share
  code.

## Deliberately not implemented

- **Views for a derived read-time projection.** Nothing emits a view; the spec's
  computed fields use virtual generated columns or triggers instead.
- **Migrations.** Only full `create` statements are produced; there is no diffing
  against an existing database.
- **Defaults and sequences.** `id` is `uuid not null` with no default, so the
  application supplies it.
- **Indexes beyond primary key, unique, and foreign key.**
- **`not null` on computed columns before the trigger runs.** A *required*
  computed column is declared `not null` and populated by a before trigger, so an
  insert that skips the trigger fails rather than defaulting. An optional one is
  nullable instead.
- **Ownership and grants.**
- **Idempotent output.** The file is plain `create` statements with no
  `if not exists` and no `drop`, so re-applying it to an existing database
  fails. Use a fresh database.
