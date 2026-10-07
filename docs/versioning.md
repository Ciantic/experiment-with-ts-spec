# Versioning

Every mutable domain model carries a `version`, an optimistic-lock counter:

- `Customer` — `version`
- `Seller` — `version`
- `Invoice` — `version`
- `InvoiceRow` — `version`
- `Email` — `version`
- `Tenant` — `version`

`InvoiceSent` and `InvoiceSentRow` do not. They are frozen copies
(`docs/invoice-snapshotting.md`); a revision of a document that is not supposed
to change is the same contradiction `updatedAt` would be.

The column is `int8`, incremented by a `before update` trigger. A caller that
sends a version other than the one stored gets a conflict raised, rather than
silently overwriting a concurrent write.

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
  (`packages/backend/src/postgres/pglite-setup.ts`,
  `packages/backend/src/postgres/pg-setup.ts`), so no mapper change is needed.
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
(`docs/timestamps.md`, `docs/optionality.md`). A defaulted version is the one
default a create never overrides: the repository leaves it out on insert,
because its default *is* the first revision.

## The trigger

One `before update` trigger per table with a `@version` column:

```sql
create function "customer_version"() returns trigger as $$
begin
    if NEW."version" is distinct from OLD."version" then
        raise exception 'version conflict on customer %', OLD."id"
            using errcode = '40001';
    end if;
    NEW."version" := OLD."version" + 1;
    return NEW;
end;
$$ language plpgsql;

create trigger "customer_version" before update on "customer"
    for each row execute function "customer_version"();
```

- **`is distinct from`, not `<>`.** A raw statement can still send a null
  version, and `null <> 0` is `NULL`, the `if` is not taken, and the trigger
  would silently accept the write. `is distinct from` is null-safe, so a null
  version conflicts rather than passing. The guard fails closed.
- **`errcode = '40001'`.** `serialization_failure` is the closest standard code
  for "retry the transaction", so a client can recognise a conflict without
  parsing the message.
- **The message names the row.** `OLD."id"` is interpolated, so a conflict is
  attributable.
- **`before update` only.** On insert there is no `OLD` to compare against. The
  `default 0` covers that path.
- **It fires after the `_compute` trigger** (Postgres orders same-timing
  triggers by name, and `customer_compute` sorts before `customer_version`).
  The two touch disjoint columns, so the order does not matter here.

## Why the increment stays in the trigger

The repository predicates on the version, and the trigger owns the increment.
Splitting the two that way is what the writers that never pass through the
repository require:

```sql
update "invoice" set "netAmount" = (select coalesce(sum(…))) where …
```

The invoice's cross-table triggers write the parent row in raw SQL when a child
row changes. That statement has no caller version to predicate on, so an
increment owned by the repository would either not run there or have to invent a
value. Under the trigger, an aggregate update omits `version`, so `NEW."version"`
equals `OLD."version"`, the check passes, and the trigger still increments: the
counter tracks every write to the row, whatever path wrote it.

The same split is what lets a generated patch work. A patch that supplied
`"version" = v."version"` in its `set` list would make `NEW` differ from
`OLD` on every write, so the guard in `## The trigger` would fire on a *correct*
patch. The repository therefore sends the version as a `where` predicate only:

```sql
update "invoice" as u set "notes" = case when v."notes#present" then v."notes" else u."notes" end
from unnest($1::uuid[], $2::text[], $3::bool[]) as v("id", "notes", "notes#present")
where u."id" = v."id" and u."version" = v."version"
```

The trigger's guard now only ever fires for a writer that sets the column
itself, which means raw SQL. It is kept because such a writer would otherwise
overwrite the counter with no complaint, and because the guard is per table
while the predicate is per statement.

## A predicate that matches nothing rejects the call

`update … from unnest(…) … returning …` reports the rows it wrote, so the
generated patch reads them back — `resultRows` in `docs/transactions.md`, since
both drivers answer a result with a `rows` array — and throws when it wrote fewer
rows than the statement's chunk carried:

```ts
const written = new Set(resultRows(result).map((row) => String(row["id"])));
if (written.size !== chunk.length) {
    throw Object.assign(new Error(…), { code: "40001" });
}
```

The reader throws too, rather than answering no rows, when a result carries no
`rows` array: a driver the port does not know must not report every patch as a
conflict.

A statement carries a chunk of rows, so a short write names the rows it left out
by their keys. `code: "40001"` is the same SQLSTATE the trigger raises, so the
router maps both to a `409` (`docs/rest-api.md`) and a client keeps one
conflict path. The thrown error aborts the surrounding transaction, so a
multi-row call whose second row is stale writes nothing at all.

Both ways of matching no row — a version the row has moved past, and an id that
does not exist — arrive as that one rejection. Telling them apart would take a
second read, and the caller's move is the same either way: re-read, then retry.

## What the check means

| Path | Sends | Stored | Result |
| --- | --- | --- | --- |
| repository patch | `3` | `3` | Matches. The trigger stores `4`. |
| repository patch | `3` | `4` | No row matches. The call is rejected, nothing written. |
| repository patch | an id that is not there | — | No row matches. Rejected the same way. |
| raw SQL, version omitted | — | `4` | Passes, stored becomes `5`. |
| raw SQL that sets `version` | `3` | `4` | `raise`, nothing written. |

The `version` omitted row is the aggregate: a writer that does not claim a
version never conflicts, but it still advances the counter. Any write moves the
version, so a client holding a pre-aggregate version is told its view is stale.

## Insert vs update vs upsert

The version has a different lifecycle from both timestamps, and it is the one
defaulted column a create never carries:

| Path | `version` | Why |
| --- | --- | --- |
| insert | omitted | `default 0` supplies the first revision. |
| repository upsert | written, as `v."version"` | It is the revision the caller claims. |
| repository patch | in the `where`, as `v."version"` | It carries the caller's precondition. |
| aggregate update | omitted | Raw SQL; the trigger advances it without a claim. |

This is the one defaulted column a create never carries
(`docs/repositories.md`), so `packages/backend/scripts/generate-repositories.ts`
builds a different column set per statement: the insert leaves out a defaulted
column flagged `version`, while the patch sends it to the predicate and never
assigns it.

Because the repository does not assign the column, `NEW."version"` always equals
`OLD."version"` on a generated write, and the trigger's guard passes while the
increment still runs. A `set` that named the version would make the guard fire
on every correct patch.

Because an update is a patch (`docs/repositories.md`), the version is one of the
two columns the patch type makes mandatory — the other is the primary key. A
caller cannot build a patch that omits the precondition.

## The upsert's claim

An upsert is the one generated write that carries the version as a value rather
than as a precondition, because it must say which revision it believes the row is
at even when no row is there yet:

```sql
insert into "customer" as u ("id", "name", "version") select v."id", v."name", v."version"
from unnest($1::uuid[], $2::text[], $3::int8[]) as v("id", "name", "version")
on conflict ("id") do update set "name" = excluded."name"
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
- **The conflict path cannot assign the version**, for the reason above: the
  trigger's guard would fire on a correct replacement.
- **A rejection is the same one a stale patch raises**, `code: "40001"` naming
  the rows the statement did not write, and the same `409` on the wire
  (`docs/rest-api.md`). Both ways of missing a row — a version the row has moved
  past, and an id that is not there — arrive as that one rejection here, since a
  missing row is inserted rather than rejected.
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
- **The aggregate update bumps the version.** Editing an `invoice_row` reassigns
  `invoice.netAmount`, which fires the invoice's version trigger. A user editing
  the invoice in that window gets a conflict. Correct, since their `totalAmount`
  is stale, but version changes are not one-to-one with user edits.
- **`JSON.stringify` throws on `bigint`.** This is the objection
  `docs/primitives.md` raises against bigint, and it applies here. Nothing in
  `packages/` serializes a spec object today, but the first HTTP or RPC boundary
  to do so will throw. Serializing with a replacer, or converting at that
  boundary, is the fix.
- **The first version is not returned.** A create and an upsert answer the keys
  they wrote, not the columns the database assigned (`docs/repositories.md`), so
  `createCustomer` does not tell the caller that the row is now at version `0`.
  Learning it takes a `RETURNING` that names the column or a read path. An
  upsert does not return the version it produced either, so a caller replacing a
  row it read at `3` learns only that the row is now at `4` by reading again.
- **`@inlined` leaks `customerVersion`.** Inlining flattens every scalar
  field, so `invoice_sent` gains a nullable `customerVersion int8` — the
  customer's revision at send time, alongside the `customerCreatedAt` and
  `customerUpdatedAt` that already leak. There is no per-field opt-out.
- **The guard is SQL, so it is not type-checked.** A wrong comparison or a
  mistyped column surfaces when the DDL runs, not at lint time — the same class
  of risk as a `@pgDefault` expression.
- **Nothing behavioural tests the generated trigger.** Per `docs/testing.md`,
  trigger semantics are deliberately out of scope, so the generator tests assert
  the emitted text and `schema.test.ts` asserts only that the file executes. A
  subtly wrong trigger would pass every test. The repository's own side — the
  predicate, the rejection, the rollback, and the increment — is exercised
  against PGlite in `packages/backend/scripts/generate-repositories.test.ts`,
  over a fixture trigger of its own.

## Deliberately not implemented

- **The version on the snapshots.** Above.
- **Returning the new version from `create`/`update`.** See the gotcha.
- **A conflict-resolution strategy.** The trigger reports; retrying, merging, or
  surfacing a conflict to a user is the caller's decision.
- **Deletes checking a version.** `deleteCustomer` keys on the primary key only.
  Deleting a row someone else has just updated is a real race, but a delete is
  idempotent enough to omit the check.

## Wiring

1. `packages/spec/src/primitives/Version.ts` defines the brand; `@version` and
   `@pgDefault 0` go on the field.
2. `packages/backend/scripts/postgres-model.ts` maps `Version` to `int8` and sets
   `Column.version` from the tag.
3. `packages/backend/scripts/generate-postgres-schema.ts` emits the column and
   `renderVersionTrigger`.
4. `packages/backend/scripts/generate-repositories.ts` omits the column on
   insert, writes the claimed one on upsert, and predicates on it on update.
5. `packages/validation/scripts/generate-zod-schemas.ts` omits the column from
   the create's field set and puts it back, required, for the upsert and the
   patch.
6. `packages/spec/scripts/lint-spec.ts` requires `@version` on a `Version` field,
   at most one per interface, exclusive with `@computed`,
   `@createdAt`, and `@updatedAt`.

See `docs/timestamps.md` for the trigger-and-default pattern this column follows.
