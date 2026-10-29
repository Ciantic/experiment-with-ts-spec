# Versioning

A field carrying `@version` is an optimistic-lock counter.

A snapshot entity — one copied at write time rather than referenced — carries no
counter. `WidgetSnapshot` and `WidgetSnapshotRow` are frozen when they are
written; a revision of a document that is not supposed to change is the same
contradiction `updatedAt` would be.

The column is `int8`. A generated patch or upsert matches the stored revision and
increments it in the same statement, so a caller that sends a version other than
the one stored matches no row and is rejected rather than silently overwriting a
concurrent write.

## The primitive

```ts
export type Version = bigint & Brand<"Version">;
```

`packages/spec/src/primitives/Version.ts`. This is a deliberate exception to
"every numeric value in the model is a decimal carried as a string"
(`docs/primitives.md`), which is about measured amounts where precision loss is
the risk. A version is infrastructure: it is compared and incremented, and
`+ 1n` on a `bigint` is exactly the arithmetic the `Decimal` rule forbids on a
string.

- **`bigint`, not `number`.** The drivers already return `int8` as a `bigint`
  (`packages/infra/src/postgres/pglite-setup.ts`,
  `packages/infra/src/postgres/pg-setup.ts`), so no mapper change is needed.
  `number` would map to `float8` and reintroduce the precision loss the counter
  exists to avoid.
- **Branded, not an alias.** `1n` is a plausible version and a plausible count;
  the brand keeps `Version` and `Quantity` from being interchangeable.

The `@pgType int8` tag on `Version` in `packages/spec/src/primitives/Version.ts` is
load-bearing, not cosmetic: the generator reads it before resolving the alias, so
without it the alias would resolve to the `bigint` keyword and emit `int8`
anyway — the same result by a different route. The explicit tag documents the
intent and survives a change to the alias.

## The column

```sql
"version" int8 not null default 0
```

`@pgDefault 0` gives a new row its first revision for free, and makes the
required field's column `not null` — the same shape as `createdAt`
(`docs/timestamps.md`, `docs/optionality.md`). A create writes a supplied
version, or `0` when the row omits it, so a fixture or a backfill may seed a
historical revision.

## The increment

There is no version trigger. A generated patch matches the stored revision and
increments it in the same statement:

```sql
update "account" as u
    set "notes" = case when v."notes#present" then v."notes" else u."notes" end,
        "version" = u."version" + 1
from unnest($1::uuid[], $2::text[], $3::bool[], $4::int8[])
    as v("id", "notes", "notes#present", "version")
where u."id" = v."id" and u."version" = v."version"
```

- **The predicate is the precondition.** `u."version" = v."version"` is what a
  stale claim fails to match, so the increment only happens on a row the caller
  held. The database no longer needs a separate guard.
- **The `set` takes the stored value, not the claim.** `u."version" + 1` is the
  next revision whatever the claim was; the two are equal on a matched row.
- **`returning` reports the match.** A row that matched no version is absent
  from the result, and the generated code rejects the call with a
  `VersionConflictError` (`40001`).
- **A raw update owns its own counter.** A hand-written `update` that omits
  `version` leaves it where it stood; one that sets it writes what it names.
  Nothing checks it. A parent row's aggregate trigger writes
  `"version" = "version" + 1` itself for this reason.

## Why the statement owns the increment

The counter has to move for every path that writes the row, including paths that
do not go through the repository:

```sql
update "widget" set "subtotal" = (select coalesce(sum(…))), "version" = "version" + 1 where …
```

A `widget`'s cross-table trigger writes the parent row in raw SQL when a child
row changes. An increment owned by a database trigger would cover that statement
automatically; an increment owned by the generated statement does not. The
increment therefore lives in the trigger's own SQL, and any other hand-written
writer must do the same. The generated writes state it in their `set` clause.

## A predicate that matches nothing rejects the call

`update … from unnest(…) … returning …` reports the rows it wrote, so the
generated patch reads `result.rows` and throws when it wrote fewer rows than the
statement's chunk carried:

```ts
const written = new Set(result.rows.map((row) => String(row["id"])));
if (written.size !== chunk.length) {
    throw new VersionConflictError(…);
}
```

A statement carries a chunk of rows, so a short write names the rows it left out
by their keys. `ConflictError` carries `code: "40001"`, the SQLSTATE clients
already treat as retriable, so the router maps it to a `409`
(`docs/rest-api.md`) and a client keeps one conflict path. The thrown error aborts the surrounding
transaction, so a multi-row call whose second row is stale writes nothing at all.

Both ways of matching no row — a version the row has moved past, and an id that
does not exist — arrive as that one rejection. Telling them apart would take a
second read, and the caller's move is the same either way: re-read, then retry.

## What the check means

| Path | Sends | Stored | Result |
| --- | --- | --- | --- |
| repository patch | `3` | `3` | Matches. The statement stores `4`. |
| repository patch | `3` | `4` | No row matches. The call is rejected, nothing written. |
| repository patch | an id that is not there | — | No row matches. Rejected the same way. |
| raw SQL, version omitted | — | `4` | Leaves it at `4`. |
| raw SQL that sets `version` | `3` | `4` | Writes `3`; nothing checks it. |

A raw writer that omits the column does not advance the counter. The aggregate
trigger maintains it explicitly; any other raw writer has to do the
same if the column is to move.

## Insert vs update vs upsert

| Path | `version` | Why |
| --- | --- | --- |
| create | written if supplied, else `0` | The default supplies the first revision. |
| repository upsert | written, as `v."version"` | It is the revision the caller claims. |
| repository patch | in the `where`, as `v."version"` | It carries the caller's precondition. |
| aggregate update | `"version" = "version" + 1` | The raw statement advances it itself. |

The generated insert writes the column because a fixture or a backfill may need a
historical revision. The patch sends the claim to the predicate and takes the
increment from the stored value. Because an update is a patch
(`docs/repositories.md`), the version is one of the two columns the patch type
makes mandatory — the other is the primary key. A caller cannot build a patch
that omits the precondition.

## The upsert's claim

An upsert is the one generated write that carries the version as a value rather
than as a precondition, because it must say which revision it believes the row is
at even when no row is there yet:

```sql
insert into "account" as u ("id", "name", "version") select v."id", v."name", v."version"
from unnest($1::uuid[], $2::text[], $3::int8[]) as v("id", "name", "version")
on conflict ("id") do update set "name" = excluded."name", "version" = u."version" + 1
where u."version" = excluded."version"
returning u."id"
```

`excluded` is the only row the `do update` can read, so the value the statement
inserted and the value the predicate compares are necessarily the same one. That
gives an upsert three outcomes per row:

| Stored | Claimed | Result |
| --- | --- | --- |
| no row | `3` | Inserted at `3`. |
| `3` | `3` | Replaced, stored becomes `4`. |
| `4` | `3` | Left alone. The call is rejected, the rows it did write rolled back. |

- **A row is born at the claimed version**, since the claim is a value in the
  insert list. The alternative — a nullable claim meaning "no such row" — cannot
  be told apart from a claim of `0`, which is a real revision, so the field is
  required and the claim is taken at face value.
- **The conflict path increments the stored version**, taking `u."version" + 1`
  after the predicate has matched the claim. It never writes the claimed value.
- **A rejection is the same one a stale patch raises**, a `ConflictError`
  carrying `code: "40001"` and naming the rows the statement did not write, and
  the same `409` on the wire (`docs/rest-api.md`). Both ways of missing a row — a
  version the row has moved past, and an id that is not there — arrive as that
  one rejection here, since a missing row is inserted rather than rejected.
- **The conflict target is the primary key.** An upsert of a row whose unique
  *other* column is taken raises the database's `23505` rather than replacing,
  and the router serves it as a `409` like any other unique violation.

Because the claim is written, an upsert of several rows opens a boundary where a
create does not: a chunk whose claim is stale has already written the rows that
matched before the generated code rejects the call
(`docs/transactions.md`).

## Gotchas

- **A conflict aborts the statement and the transaction.** For a multi-row
  `update…`, one stale row rolls back all of them, including the rest of its own
  chunk and the rows the earlier chunks already wrote. This is intended — a batch
  is one logical write and retrying it is the caller's job — but it is a change
  from "skip the losing row". An upsert behaves the same way for the rows it
  wrote before the claim it could not match.
- **A rejection names the rows it did not write, but not why.** A stale version
  and a missing id are both `40001` → `409`. A caller that needs to tell them
  apart reads first. An upsert reads a missing row as a row to create, so the
  only way it rejects a row is a version the stored one has moved past.
- **The aggregate update bumps the version.** Editing a `widget_row` reassigns
  `widget.subtotal`, and the aggregate trigger statement also writes
  `"version" = "version" + 1`. A user editing the widget in that window gets a
  conflict. Correct, since their `total` is stale, but version changes are
  not one-to-one with user edits.
- **`JSON.stringify` throws on `bigint`.** This is the objection
  `docs/primitives.md` raises against bigint, and it applies here. Nothing in
  `packages/` serializes a spec object today, but the first HTTP or RPC boundary
  to do so will throw. Serializing with a replacer, or converting at that
  boundary, is the fix.
- **The first version is not returned.** A create and an upsert answer the keys
  they wrote, not the columns the database assigned (`docs/repositories.md`), so
  `createAccount` does not tell the caller that the row is now at version `0`.
  Learning it takes a `RETURNING` that names the column or a read path. An
  upsert does not return the version it produced either, so a caller replacing a
  row it read at `3` learns only that the row is now at `4` by reading again.
- **`@inlined` leaks `accountVersion`.** Inlining flattens every scalar
  field, so `widget_snapshot` gains a nullable `accountVersion int8` — the
  account's revision at snapshot time, alongside the `accountCreatedAt` and
  `accountUpdatedAt` that already leak. There is no per-field opt-out.
- **A raw update owns the counter.** Nothing in the database guards or advances
  it, so a hand-written statement that omits `version` leaves the row at its old
  revision, and one that sets it can move the row backwards. The generated writes
  and the aggregate trigger maintain it explicitly.

## Deliberately not implemented

- **The version on the snapshots.** Above.
- **Returning the new version from `create`/`update`.** See the gotcha.
- **A conflict-resolution strategy.** The statement reports; retrying, merging, or
  surfacing a conflict to a user is the caller's decision.
- **Deletes checking a version.** `deleteAccount` keys on the primary key only.
  Deleting a row someone else has just updated is a real race, but a delete is
  idempotent enough to omit the check.

## Wiring

1. `packages/spec/src/primitives/Version.ts` defines the brand; `@version` and
   `@pgDefault 0` go on the field.
2. `scripts/infra/postgres-model.ts` maps `Version` to `int8` and sets
   `Column.version` from the tag.
3. `scripts/infra/generate-postgres-schema.ts` emits the column and no
   version trigger.
4. `scripts/infra/generate-repositories.ts` writes the column on
   insert, claims it on upsert, and predicates on it while incrementing it on
   update.
5. `scripts/sdk/generate-zod-schemas.ts` relaxes the column on a create,
   and makes it required for the upsert and the patch.
6. `scripts/spec/lint-spec.ts` requires `@version` on a `Version` field,
   at most one per interface, exclusive with `@computed`,
   `@createdAt`, and `@updatedAt`.

See `docs/timestamps.md` for the default-and-fallback pattern this column follows.
