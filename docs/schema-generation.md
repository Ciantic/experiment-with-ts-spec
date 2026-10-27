# Schema generation

`scripts/backend/generate-postgres-schema.ts` turns the entities in
`packages/spec/src/` into Postgres DDL.

The spec is parsed by `scripts/spec/spec-model.ts`; the Postgres table
model is built by `scripts/backend/postgres-model.ts`, which both this
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

Named spec types are mapped by the `@pgType` tag their alias declares, so the
mapping lives on the primitive, not in the generator. Adding a
primitive is a spec-only change. The tag is checked rather than trusted: the
linter reads the same vocabulary, and requires the named type to select as the
JavaScript type the alias resolves to. The vocabulary and the built-in defaults
below are `scripts/spec/pg-types.ts`, which both the linter and this
generator read:

- The keyword types `string` → `text`, `number` → `float8`, `boolean` →
  `boolean`, `bigint` → `int8`.
- `Date` (the built-in) → `timestamptz`.

The model fills `pgType` for an alias that omits it — inheriting the value of the
alias it names, or the keyword default — so a named type maps by reading
`tags.pgType`. Only a union, an array, and an entity fall through to the walk
below, which is where their CHECK, cardinality, and relation are decided.

Everything else resolves through the alias tree:

- A `@primitive` alias (`UUIDv7`, `Decimal`, `Money`, `Version`, and so on) → the
  type its `@pgType` names.
- `BrandedId<...>` and any `<Entity>Id` alias → `uuid`.
- A union of string literals (such as `"draft" | "released"`) → `text` plus a
  CHECK constraint listing the values.
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
- `@foreignKey <Entity> scope=<column>` makes the reference composite, emitted as
  a table constraint over `(scope, column)` rather than an inline `references`:
  the pair must exist on the target, so the two cannot disagree. `<column>` is the
  one `<Entity>` declares with `@tenantOwned`, and the generator adds the unique
  constraint the pair needs on the target as `(<column>, <key>)`. See
  `docs/tenancy.md`.
- `@relation` on an entity-typed field adds no column of its own. It navigates
  through the `@foreignKey` field pointing at its table; that field's optionality
  sets the nullability. A `@relation` with no such field, or more than one
  candidate, is a diagnostic.
- `@children` on an array field is skipped; the child table owns the foreign key.
- `@unique` adds a `unique` constraint.
- `@pgDefault <expression>` appends `default <expression>`. The column is `not null`,
  so the field is required. The repository generators name the column in
  their statements, and a row that omits it writes the declared default, so that
  row gets the value the database would have filled. A field inherits the
  expression from its type's `@pgDefault` unless it declares its own; a field
  tag overrides it, and an empty one clears it. A `@foreignKey` field never
  inherits, because its value is copied from another row. It may accompany
  `@computed`, where the default applies to the insert path and the trigger to
  every write. A defaulted `@version` behaves the same way: a create may claim
  one or take `0`. See `docs/optionality.md`.
- `@createdAt`/`@updatedAt` append `default now()`. A generated write supplies a
  value or falls back to the default; no trigger assigns either clock. See
  `docs/timestamps.md`.
- `@pgAutoIncrement` appends `generated by default as identity`. The column must
  be an integer and is always the primary key; the repository generators leave it
  out of a create, which reads the assigned value back, and name it in an upsert,
  where the key is the claim. See `docs/auto-increment.md`.
- `@computed @pgVirtual <expression>` appends
  `generated always as (<expression>) virtual`. The column is never written by
  the repository.

Columns are named exactly as the fields, quoted camelCase, matching the
expressions in the spec tags. There is no name mapping.

## Ordering

Tables are emitted so that referenced tables come first. A cycle is reported as
a diagnostic and the remaining tables are emitted in encounter order — the DDL
would then need manual reordering or deferred constraints.

## Triggers

`@computed @pgTrigger` fields become row-level triggers. Without a header the
trigger is `before insert or update` on the field's own table, assigning in
interface field order. Order matters on `widget_row`: the assignments are
`subtotal`, `surcharge`, `total`, and each reads the previous one, so they
cannot be virtual columns.

The statements are plpgsql, so every reference to a column of the row being
written must be `NEW`-qualified. An unqualified `"quantity"` is a plpgsql error
(`column "quantity" does not exist`), not an implicit `NEW` lookup. A virtual
column's expression is the opposite: it is a SQL expression, so it must *not* be
`NEW`-qualified, and the linter does not check which form a field used. A
statement-level trigger has no `NEW` or `OLD` at all — both are null — so a
statement that reads either fails at run time, which is why a field-level
trigger, whose column needs filling, may not be statement-level.

A trigger with a header takes the timing, events, table, and level the header
names, so one table can carry a `before insert or update` function, an `after
insert` function, and so on. Every trigger on one table with the same timing,
events, and level shares one function and one `create trigger`. The function is
named `<table>_compute` for the shared row-level before insert or update shape,
and `<table>_<timing>_<events>`, with a `_statement` suffix when it is
statement-level, otherwise. A `before` row trigger returns `NEW`, or
`coalesce(NEW, OLD)` when it fires on delete, since `NEW` is null there and
returning it would cancel the delete. An `after` trigger returns null, as does a
statement-level one, whose return value Postgres ignores.

A field's statements sit in interface field order, and an interface-level
`@pgTrigger`'s statements come after all of them, in the same function when the
shape agrees. That placement is what lets an interface-level statement read a
derived value: were it emitted first, it would see whatever the client sent.

Neither clock nor version columns generate a trigger. The generated writes
assign the clocks and increment the version themselves (`docs/timestamps.md`,
`docs/versioning.md`), so the only triggers are the `@pgTrigger` statements an
entity declares.

A cross-table aggregate cannot run as a before trigger on the parent, because
the child rows do not exist yet at insert. Its header therefore reads `after
insert or update or delete on <Child>`, which attaches the trigger to the child
table and `update`s the parent with a fresh `sum`. The statement must be correct
for all three events, so it names the parent row it recomputes with `in
(OLD."<fk>", NEW."<fk>")`: an update that moves a row from one parent to another
refreshes both, which a statement reading `NEW.` alone would not.

The widget total is not part of that update. It is a virtual generated column
over `"subtotal" + "surcharge"`, so it recomputes on read. The trigger's
statement also writes `"updatedAt" = now()` and `"version" = "version" + 1`,
because no generated write runs there to maintain them (`docs/timestamps.md`).

A child whose foreign key points at the parent but which no trigger names gets no
trigger. A statement that reads such a child's table without attaching to it is a
generation error, because that child's writes would leave the aggregate stale.

## Validation

Two test files:

- `scripts/backend/generate-postgres-schema.test.ts` — the generator's
  behaviour, driven by self-contained in-memory fixtures. It does not read the real
  spec, so it stays valid as the domain changes. The fixture's sources go through
  `parseInMemorySpec(files, { sourceGlob })`, so a fixture is generated
  from its own files.
  Its trigger group also executes the generated triggers in PGlite, which is the
  one place the attachment is observable: a trigger on the wrong table is valid
  SQL, so no text assertion can see it.
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

Beyond the trigger wiring, none of these assert what the schema *means*. A trigger
that computes the wrong column, or an aggregate that sums the wrong thing, passes
the text assertions — the SQL is valid and the text is as generated. A field's
expression is only checked by reading it.

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
  `bigint`, so an `int8` column arrives as a `bigint` however large its value.
- **The fragments must be `NEW`-qualified** (see above). Running the DDL is what
  revealed this.
- **A foreign key takes the database default unless the key declares an
  action,** so a referenced row cannot be deleted unless the key opts into
  nulling or cascading. `@foreignKey Account onDelete=cascade` — or
  `onUpdate=<action>` — appends the clause. See `docs/spec-annotations.md`.
- **A scoped reference replaces the single-column one.** The composite constraint
  already requires the key to exist on the target, so emitting both would be a
  second check of the same fact. A `scope` with `onDelete=setNull` is a lint
  finding, because nulling the pair would null a required column. See
  `docs/tenancy.md`.
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

- `int8` returns `bigint`.
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
- **Everything numeric is `decimal`.** Amounts, quantities, and percentages
  share one type, so the drivers return strings for all of them, matching the
  `Decimal` brand. Rounding to two decimals is in the expression
  (`round(..., 2)`), not in the column type, so a stored amount's scale is
  defined in one place.
- **Only the OIDs listed in each file are remapped.** Anything else delegates to
  the driver's own parser.
- **PGlite parsers are keyed by OID in a `ParserOptions` object**, whereas `pg`
  takes a `getTypeParser` replacement. That is why the two files do not share
  code.

## Deliberately not implemented

- **Views for a derived read-time projection.** Nothing emits a view; a
  computed field uses a virtual generated column or a trigger instead.
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
