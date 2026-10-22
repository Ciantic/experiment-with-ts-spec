# Repositories

`packages/backend/scripts/generate-repositories.ts` writes one module per
operation into `packages/backend/src/db/repositories/`, named after the function
it exports: `createWidget.ts`, `upsertWidget.ts`, `updateWidget.ts`,
`deleteWidget.ts`. An entity generates only the operations its `@repository`
tag names, so a table that is appended to and never changed has a create module
and no others. See `docs/spec-annotations.md`.

- `pnpm generate:repositories` — writes the operation modules and their barrel.
- `pnpm generate:repositories --out <dir>` — writes elsewhere. A missing directory is created.

The output is committed. Regenerate rather than editing it by hand.

## What a repository is here

Each entity gets one module per operation `@repository` names — four for an
entity that carries the whole set:

```ts
// createAccount.ts
createAccount(db: SqlExecutor, rows: AccountInsert[]): Promise<AccountPrimaryKey[]>
// upsertAccount.ts
upsertAccount(db: SqlExecutor, rows: AccountUpsert[]): Promise<AccountPrimaryKey[]>
// updateAccount.ts
updateAccount(db: SqlExecutor, rows: AccountPatch[]): Promise<void>
// deleteAccount.ts
deleteAccount(db: SqlExecutor, rows: AccountPrimaryKey[]): Promise<void>
```

The barrel `index.ts` re-exports every generated operation module, so a caller
imports the function it wants from one path. An operation the tag omits is
absent from the barrel and has no module, so a caller cannot reach it. A
regeneration also removes a module the spec no longer declares, so a narrowed
`@repository` leaves no stale file behind.

`create` takes an **insert** — the fields a create writes — and `update` takes a
**patch**, so a caller changes the fields it has without having to read and
resend the rest; see "Inserting" and "Patching" below. `upsert` takes an
**upsert**, which is the insert's field set plus the version the caller claims,
and writes the row whole; see "Upserting". `delete` takes the **primary key**,
because the key is the whole of what its statement reads.

**Reading is not part of a
repository.** There is no `getById`, no list, no query builder. Those belong to
whatever reads the data — a projection, a report, a view — and are deliberately
not part of a repository, because their shape is a product decision rather than
a mapping of the spec. Reads are generated separately from the entities in
`packages/backend/src/db/queries/`; see `docs/queries.md`.

`SqlExecutor` (`src/db/sql-executor.ts`) is the whole database surface:
`query(sql, parameters?)`, `transaction(run)`, and `transactionWith(options, run)`
where the caller names the modes its own boundary opens with
(`docs/transactions.md`). The generated modules never import a driver, so `pg`
stays an optional dependency. A driver reaches the port as a `SqlPool`
(`src/db/sql-pool.ts`): `pg`'s `Pool` satisfies it directly, and PGlite through
`createPglitePool`. Tests assert both fits, so the structural types cannot drift
away from the drivers.

## What a write returns

A create and an upsert return the keys they wrote, one per row they were given,
in the order they carried them; `update` and `delete` return nothing. A call
with no rows returns an empty array, so an empty call and a short write read
differently.

The key comes back from the statement rather than being echoed from the input,
because the database may own it: an `@pgAutoIncrement` column is assigned on
insert (`docs/auto-increment.md`), and a `@pgDefault` key expression is evaluated
there. The type is the one
`delete` takes — the entity projected to its `@primaryKey` fields — so a composite
key returns every column of the key. A caller that supplied the key itself may
ignore the result; one that did not needs it, and over REST it is the response
body (`docs/rest-api.md`).

## Why arrays

A repository that takes one row per call forces one round trip per row. Taking
an array lets one call carry many rows, which is the whole reason the functions
exist in this shape:

- **create** — one `insert into "t" (...) select … from unnest(...)` per chunk of rows, in one boundary when a call spans several chunks.
- **upsert** — the same insert with `on conflict ("id") do update set … = excluded.…`, predicated on the version where the entity has one, in one boundary whenever the call carries more than one row.
- **update** — one statement per chunk of rows, `update "t" as u set ... from unnest(...) as v(...) where u."id" = v."id"`, in one boundary whenever the call carries more than one row.
- **delete** — one `delete from "t" using (values (...), (...)) as data("id") where "t"."id" = data."id"`.

Each function returns early on an empty array, so the caller does not have to
guard.

## Inserting

`create` takes an insert rather than the whole entity. The type lives in
`packages/sdk`, in the module that also exports the schema accepting the
same fields, and the repository imports it:

```ts
import type { WidgetInsert } from "sdk/repositories/widgetInsertSchema.ts";

export async function createWidget(db: SqlExecutor, rows: WidgetInsert[]): Promise<WidgetPrimaryKey[]>
```

`WidgetInsert` is the entity minus every field the statement does not write, so
it mirrors the SQL exactly. A whole entity is still assignable to it, so a caller
holding one can pass it unchanged. What the type rules out is a field that would
be read and then dropped — a branch, a `@pgVirtual` column, or a derivable
value — which is the same set `<entity>InsertSchema` accepts
(`docs/validation.md`). The type is built by `Insert`
(`packages/sdk/src/insert.ts`), so an entity with no field to omit, relax,
or widen still gets an `Insert<…, never, never, never>`, which resolves to the
entity type itself.

The statement binds one array per column and reads them as rows with `unnest`,
the shape `Patching` describes in full: a column a row may leave out binds a
second array of flags saying whether that row supplied it.

```sql
insert into "account" ("id", "name", "source") select
    v."id",
    v."name",
    case when v."source#present" then v."source" else 'manual' end
from unnest($1::uuid[], $2::text[], $3::text[], $4::bool[])
    as v("id", "name", "source", "source#present")
```

The fallback for an omitted column is the column default, where a patch falls
back to the value the row already holds. A create may therefore omit a column
with a database default, and the statement writes the declared default,
since the `default` keyword is not allowed outside an `insert … values` list. A
required field with a default is relaxed to optional in `<Entity>Insert`, and its
schema is `.partial()`, so the type and the wire agree that omitting it is
allowed. A supplied value always wins, which is what lets a seed or a backfill
carry a historical `createdAt`, `updatedAt`, or `version`.

A nullable column accepts `null` as well as omission, since the two are one
request for a create: the column has no default to fall back on, so either writes
a null. `<Entity>Insert` and `<entity>InsertSchema` widen the same set a patch and
an upsert do, from `nullablePatchProperties` (`docs/validation.md`).

One statement binds at most `MAX_STATEMENT_PARAMETERS` values
(`src/db/sql-executor.ts`), so a create whose rows would bind more than that
splits into chunks of `floor(MAX_STATEMENT_PARAMETERS / <bound arrays>)` rows. A
call that fits in one chunk is one statement and runs on the handle it was
given; a call that spans several chunks opens a boundary and runs them all
in it, nested as a savepoint when the caller already holds one, so the rows
still commit together. The bound is the driver's rather than the protocol's:
PostgreSQL accepts 65535 parameters, while PGlite past 32767 drops the
statement without an error and answers nothing afterwards, so the generated
code stays inside the smaller number. The shortfall is PGlite's own: it reads
and writes the protocol's 16-bit counts with the signed `getInt16`/`setInt16`,
where the wire format is unsigned. Filed upstream as
[electric-sql/pglite#1118](https://github.com/electric-sql/pglite/issues/1118);
the constant can move to the protocol's 65535 once that is fixed.

An insert writes every row it carries, so each statement's returned-row count is
compared with the chunk it was given, and a short count is a rejected call. That
is what makes a silent loss loud: a `before insert` trigger returning `null`
skips its row without raising, and a driver that quietly declines a statement
answers nothing at all. Neither is a caller's mistake, so the thrown
`ShortWriteError` carries no SQLSTATE and the router serves it as a server fault.
The rows the statement returns are the keys the call answers with, so the check
and the return value are the same read.

## Patching

`update` takes a patch rather than a whole entity. The type lives in
`packages/sdk`, narrowed to the columns the statement writes, and the
repository imports it:

```ts
import type { AccountPatch } from "sdk/repositories/accountPatchSchema.ts";

export type AccountPatch = Omit<Partial<Account>, "createdAt"> & Required<Pick<Account, "id" | "version">>;
```

Every written column is optional except two, which are the keys the rest of the
design leans on:

- **The primary key** says which row to write. It is the field or fields tagged
  `@primaryKey`; a composite key requires every one of them, and the statement
  matches a row on all of them.
- **The `@version` column**, where one exists, is the optimistic-lock
  precondition (`docs/versioning.md`). It is required so a patch cannot
  accidentally skip the check. For an entity with no `@version` field, only the
  key is required.

A field the statement does not write is left out of the type rather than being
accepted and ignored, so `<Entity>Patch` permits exactly the fields its `update`
touches. That is a branch — a `@relation` or `@children` field, which has no
column — a column the database owns outright: a virtual generated column
(`@pgVirtual`), or a nullable `@computed` field its mechanism fills in.
`createdAt` is left out because it is set once; a `@pgDefault` column is *not* on
this list, and neither is `updatedAt`: a patch may override either, the same way
a create may.

`update` writes one statement per chunk of rows, naming every column a patch may
supply. Whether a row supplied one travels with the row as a presence flag, so a
field the caller omitted keeps its stored value while a field the caller sets to
`null` writes a null:

```sql
update "account" as u
    set "name" = case when v."name#present" then v."name" else u."name" end,
        "updatedAt" = case when v."updatedAt#present" then v."updatedAt" else now() end,
        "version" = u."version" + 1
from unnest($1::uuid[], $2::text[], $3::bool[], $4::timestamptz[], $5::bool[], $6::int8[])
    as v("id", "name", "name#present", "updatedAt", "updatedAt#present", "version")
where u."id" = v."id" and u."version" = v."version"
returning u."id"
```

Nothing is derived from a `null` on its own, because a null cannot say whether
the caller omitted the field or sent it as `null`; each row therefore carries the
flag beside the value, and the `set` clause asks for the flag. `coalesce` cannot
tell the two apart, so a null would read as "not supplied" and the stored value
would be kept. The `#present` suffix cannot collide with a column, because a spec
field name holds no `#`.

A column therefore costs two elements per row, its value and its flag, and a
chunk is sized on that: `ROWS_PER_STATEMENT` counts the cells a row carries the
way the insert counts its columns. An entity with no writable column at all sets
its key to the key it already holds, so the statement stays valid whatever a
patch carries.

The key columns and the version travel in the same arrays: the keys match each
row to the one it addresses, and the version goes into the `where`, so a stale
one matches no row. The `set` clause increments the stored version rather than
assigning the claim, so a matched row moves to the next revision
(`docs/versioning.md`).

A statement that writes fewer rows than its chunk carried is a rejected call
rather than a no-op: the statement returns the keys it wrote, and the generated
code throws a `ConflictError` carrying `code: "40001"` and naming the rows it
did not, which is the `409` the router already serves for a version conflict.
That covers both a stale version and an id that is not there.

A call carrying more than one row opens a boundary, and its chunks commit
together; a single row is one atomic statement and runs on the handle it was
given. Several rows need the boundary even when one statement carries all of
them, because the statement writes the rows it matches before the rejection is
raised. See `docs/transactions.md`.

`<Entity>Patch` and `<name>PatchSchema` are the same set: both are built from
`omittedFromPatch` and `nullablePatchProperties` (`packages/spec/scripts/spec-model.ts`)
into one `packages/sdk` module, so the repository type and the wire schema
cannot drift apart. A field neither writes is a 400 on the wire and a type error
in process, rather than a field that quietly does nothing (`docs/validation.md`).

## Upserting

`upsert` writes a row whole: **the row a create would write, if the key is free,
and a replacement of the stored row if it is not**. It takes `<Entity>Upsert`,
the insert's field set with the `@version` column put back:

```ts
import type { AccountUpsert } from "sdk/repositories/accountUpsertSchema.ts";

export type AccountUpsert = Upsert<Account, never, "id" | "version", "description" | …, "createdAt" | "updatedAt">;
```

A create may take a defaulted version or claim one. An upsert must always claim
it: it has to say which revision it believes the row is at, so the column is
required and the statement writes what it carries. The clocks stay optional, and
an omitted one falls back to `now()`:

```sql
insert into "account" as u ("id", "name", "email", "createdAt", "updatedAt", "version") select
    v."id", v."name", v."email",
    case when v."createdAt#present" then v."createdAt" else now() end,
    case when v."updatedAt#present" then v."updatedAt" else now() end,
    v."version"
from unnest($1::uuid[], $2::text[], $3::text[], $4::timestamptz[], $5::bool[], $6::timestamptz[], $7::bool[], $8::int8[])
    as v("id", "name", "email", "createdAt", "createdAt#present", "updatedAt", "updatedAt#present", "version")
on conflict ("id") do update set
    "name" = excluded."name",
    "email" = excluded."email",
    "updatedAt" = excluded."updatedAt",
    "version" = u."version" + 1
where u."version" = excluded."version"
returning u."id"
```

- **The key is the conflict target.** A row is addressed the way a delete
  addresses one, and the `set` list never names a key column. An
  `@pgAutoIncrement` key is named in the insert even though a create leaves it
  out, because the claim on the key is what the conflict matches
  (`docs/auto-increment.md`).
- **The version is compared, then incremented.** The `where` matches the stored
  revision against the claim, and the `set` writes `u."version" + 1` rather than
  the claimed value. The claim is therefore both what a new row is born at and
  what the stored row must hold for the replacement to happen
  (`docs/versioning.md`).
- **A row at another version is left alone**, so the statement writes fewer rows
  than it carried, and the generated code rejects the call with a
  `VersionConflictError` naming those rows — the same rejection a stale patch
  raises. The target is aliased only where the predicate needs it, so an entity
  with no version conflicts on the key and replaces unconditionally.
- **An entity with no `@version` field** has nothing to claim, so its
  upsert is the create's statement plus `on conflict ("id") do update`: no
  predicate, and every conflicting row replaced. A short count
  there is not a stale claim but a row the database declined to write, and it
  raises a `ShortWriteError`, as a create raises.

`excluded` is the whole of what the conflict path can read: PostgreSQL does not
let the `do update` see the statement's own source relation, so the upsert cannot
ask whether a row supplied a field. **An upsert is a replacement, not a patch.**
Every column the insert names is written on both paths, so

- a column a row omits takes its default, even on a row that already holds a
  value, where a patch would have kept it, and
- a branch the row leaves out writes nulls over the stored snapshot, where a
  patch would have left `row.account` alone.

A caller that wants to change some fields without reading the rest wants
`update`; a caller that holds the whole row wants `upsert`. The `<Entity>Upsert`
type is the create's, so it inherits the create's relaxed fields: a required
`@pgDefault` field may still be omitted, and an omitted defaulted column takes its
default here exactly as it does in an insert.

A nullable column also accepts `null`, the way a patch does:

```ts
export type WidgetUpsert = Upsert<Widget, "account" | "supplier" | … , "id" | "version", "code" | "notes" | …, never>;
```

Because the statement writes every column it names either way, `null` and an
omitted field are one request here — there is no "keep the stored value" to
distinguish them from. `null` is accepted because a caller holding a row from a
form or another JSON surface carries `null` where the spec carries an absent
field, and the value array takes it unchanged. The key and the version stay
locked, so neither can be cleared, and a column that cannot hold a null is not
widened: sending one is the database's `23502`, which the router serves as a 400.
The set the schema widens is the patch's, from `nullablePatchProperties`, so the
two agree on which columns are nullable.

A call carrying more than one row opens a boundary, as a patch does: a chunk
whose claim is stale has already written the rows that matched before the
rejection is raised.

## Deleting

`delete` takes an entity's **primary key**, `<Entity>PrimaryKey`, the key alone
rather than the whole entity, because the key is the only thing its statement
reads. The type and its matching `<name>PrimaryKeySchema` are generated from the
`@primaryKey` fields in `packages/sdk`, in the by-key module:

```ts
import type { AccountPrimaryKey } from "sdk/repositories/accountPrimaryKeySchema.ts";

export type AccountPrimaryKey = Pick<Account, "id">;
```

A composite key names every one of its columns, and the delete's `where` matches
on all of them, so a partial key cannot address a row:

```ts
export type WidgetTagPrimaryKey = Pick<WidgetTag, "widgetId" | "tag">;
```

The wire schema is the same field set — the delete route validates
`z.array(accountPrimaryKeySchema)` — so the caller, the schema, and the
statement agree on what a delete carries (`docs/rest-api.md`).

## Where the columns come from

The generator does not read `schema.sql` and does not re-parse the spec: it
consumes the same table model as the schema generator, from
`packages/backend/scripts/postgres-model.ts`, which maps the parsed spec
(`packages/spec/scripts/spec-model.ts`) to columns. One interpretation of
`@pgTable`, `@relation`, `@children`, `@inlined`, the `@primaryKey`/`@foreignKey`
key tags, and type mapping feeds both the DDL and the repositories, so a
repository cannot name a column the schema does not have.

The column value is read through the accessor recorded on the model, so an
inlined optional account is written as `row.account?.name`, without the
generator special-casing it. A relation contributes no column of its own: its
`@foreignKey` field is an ordinary column, read as `row.accountId`.

A column with a database default (`@pgDefault`) is written when the row supplies
it, and its tuple carries the default expression when the row omits it, so the
row gets the value the database would have filled. The clock tags and a
defaulted `@version` follow the same rule: a create writes a supplied value, or
`now()` / `0`. See `docs/timestamps.md`.

A `@computed` column the database can fill later is left out too, so the
`insert` names exactly the insertable fields and nothing else. That is the whole
of `<entity>InsertSchema`, which is why the statement and the wire schema cannot
disagree (`docs/validation.md`). A nullable trigger-derived column is
in that set; a `@pgVirtual` column always is, required or not, because Postgres
rejects a write to a generated column outright. A *required* trigger-derived
column stays: it has no default and no nullable column, so the insert has to
carry it.

A *nullable* computed column is likewise left out of a patch, and out of the
`update` statement with it: a `before insert or update` trigger reassigns the
column from the fields it derives from, so naming it would write a value the
trigger then overwrites. A *required* computed column stays in the patch, since
it has no stored value to fall back on.

A `@version` column is the one field whose role differs by operation. A create
and an upsert write it, a patch sends it into the `where` as the optimistic-lock
precondition, and the statement increments the stored value on a match. The
generator therefore builds the insert, upsert, and patch column sets separately;
see `docs/versioning.md`.

## Where the SQL comes from

Each operation has a pure planner beside its generator: `createStatement`,
`upsertStatement`, `updateStatement`, and `deleteStatement` return the
statement's SQL fragments and the arrays it binds, planned from the table model
alone — no database, no rows. `statementSql` reads the fragments back as the one
string the module concatenates them into.

The generator emits those same fragments as literals, so the SQL a repository
runs is a value its tests assert on directly, without a database. A tie-back
test runs a generated module against a recording executor and compares the SQL
it was handed with the planner's, so the two cannot drift.

## Gotchas

- **A foreign key has no `ON DELETE` clause unless the key declares one**, so
  `deleteWidget` fails while rows still reference it. Deleting children is the
  caller's job unless the child's `@foreignKey` says `onDelete=cascade`. See
  `docs/spec-annotations.md`.
- **A required computed column is supplied and then overwritten.** The insert
  sends it, the before-trigger overwrites it, so passing a value has no effect.
  Whether one is required follows the field's optionality, not the computation:
  `WidgetSnapshotRow.subtotal` is required and `not null`, so the insert has to
  carry it, while `WidgetRow.subtotal` is optional and its column nullable. A
  *nullable* computed column is named in neither the `insert` nor the `update`,
  so its value is left to the trigger that fills it
  (`docs/validation.md`).
- **A defaulted column is written only when the caller supplies it.** A create
  that omits one writes the declared default, so that row gets the same
  value the database would have; a patch that omits one keeps the stored value,
  and an upsert that omits one resets it to the default. `createdAt` and
  `updatedAt` are ordinary defaulted columns on a create, so a caller may supply
  a historical instant. A patch never writes `createdAt`; it writes `updatedAt`
  when supplied and refreshes it to `now()` when omitted. A `@version` column is
  written on create and upsert, and on update it goes into the `where` while the
  statement increments the stored value.
- **`update` enforces the version with a predicate, then increments it.** The
  `@version` column is matched in the `where`, so a stale one matches no row and
  the generated code rejects the call with the `40001` that maps to a `409`,
  naming the rows the statement did not write. The statement's `set` writes
  `u."version" + 1`. A rejection does not say whether the version was stale or
  the row was missing. See `docs/versioning.md`.
- **A patch cannot set a non-nullable column to null.** Nullable columns are the
  exception: a patch sets one to `null` to clear it. An optional `notes` or
  `code` field, and an optional foreign key, are the ones here.
- **A create takes `null` for the same nullable columns.** It means the same as
  omitting the field, since the column has no default to fall back on; both write
  a null. The insert schema and `<Entity>Insert` widen the patch's nullable set.
- **A patch or an upsert of several rows is one statement per chunk of rows.**
  The chunks commit together in one boundary, so the call is atomic, but it is
  not the single statement a create or a delete is. Passing one row avoids the
  boundary entirely. See `docs/transactions.md`.
- **A patch or an upsert whose rows disagree about who won rejects all of them.**
  One stale row aborts the boundary, so rows the earlier statements already
  matched are rolled back too. Retrying is the caller's job.
  See `docs/versioning.md`.
- **A patch is all-or-nothing per row, not per field-set.** The statement names
  every column a patch may write, and each row's flag says which of them the
  caller sent, so a row that omits a field writes the stored value back. That is
  a no-op, but it means the flags are the signal of what the caller sent rather
  than the `set` clause.
- **`delete` keys on the primary key only.** `deleteAccount` takes
  `AccountPrimaryKey[]` and has no patch variant and no version precondition.
- **An upsert replaces; it does not patch.** Every column the insert names is
  written whether the row exists or not, so a field the caller leaves out takes
  its default and a branch it leaves out is written as nulls. `excluded` is all
  the conflict path can read, so there is no per-field "keep what is stored". A
  nullable column accepts `null` for convenience, but it means the same as
  omitting the field.
- **An upsert conflicts on the primary key.** A clash on another unique index —
  `Widget.code`, `WidgetSnapshot.code` — is a `23505`, and a `409`, rather than
  the row being replaced. There is no `@upsertKey` annotation.
- **An upsert claims a version, so its rows are born at one.** A missing row is
  created at the version its row carries rather than at `0`, and a row that
  exists at another version rejects the call. See `docs/versioning.md`.
- **No transaction wrapping by the caller.** A create or a delete is atomic on
  its own, and a patch or an upsert of several rows opens its own boundary;
  anything spanning more than one *call* needs a boundary the caller opens:
  `SqlExecutor` carries `transaction`, and a repository does not call it for that
  (`docs/transactions.md`).

## Deliberately not implemented

- **Queries.** Reads are generated from the entities in
  `packages/backend/src/db/queries/`, not in a repository; see `docs/queries.md`.
- **Cascade delete inferred from `@children`.** The parent's `@children` field
  adds no `on delete cascade`; the action lives on the child's `@foreignKey`, so
  a parent with children cannot be deleted unless the child declares it.
- **A unit of work inside a repository.** No function opens a boundary: a
  repository runs its statement on the executor it is handed, and a caller that
  needs more than one call to be atomic opens the boundary itself
  (`docs/transactions.md`).
- **A drift test.** Like `schema.sql`, staleness is caught by running
  `pnpm generate:repositories`, not by a test.
