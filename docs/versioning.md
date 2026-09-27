# Versioning

Every mutable domain model carries a `version`, an optimistic-lock counter:

- `Customer` — `version`
- `Invoice` — `version`
- `InvoiceRow` — `version`

`InvoiceSent` and `InvoiceSentRow` do not. They are frozen copies
(`docs/invoice-snapshotting.md`); a revision of a document that is not supposed
to change is the same contradiction `updatedAt` would be.

The column is `int8`, incremented by a `before update` trigger. A caller that
sends a version other than the one stored gets a conflict raised, rather than
silently overwriting a concurrent write. This replaces the "last-writer-wins"
note in `docs/timestamps.md`.

## The primitive

```ts
export type Version = bigint & $brand<"Version">;
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

The `NAMED_TYPES` entry in `packages/backend/scripts/spec-model.ts` is
load-bearing, not cosmetic: `resolveNamedType` checks the map before alias
resolution, so without `Version: "int8"` the alias would resolve to the `bigint`
keyword and emit `int8` anyway — the same result by a different route. The
explicit entry documents the intent and survives a change to the alias.

## The column

```sql
"version" int8 not null default 0
```

`@default 0` gives a new row its first revision for free, and forces the column
`not null` even though the field is optional — the same shape as `createdAt`
(`docs/timestamps.md`). The repository omits it on insert.

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

- **`is distinct from`, not `<>`.** The field is optional, so a caller can send
  `undefined`, which arrives as `null`. `null <> 0` is `NULL`, the `if` is not
  taken, and the trigger would silently accept the write. `is distinct from` is
  null-safe, so an omitted version conflicts rather than passing. The guard
  fails closed.
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

## Why a trigger, not a predicate in the repository

The obvious alternative is to put the guard in the generated `update`:

```sql
set …, "version" = "t"."version" + 1
where "t"."id" = data."id" and "t"."version" = data."version"
```

That is atomic — predicate and increment share one statement under a row lock —
so it is not a race. It is still the wrong shape here, for two reasons.

**It misses the writers that matter.** The invoice rollup triggers run
`update "invoice" set "netAmount" = …` in raw SQL when a child row changes. Those
statements never pass through `updateInvoice`, so a predicate there does not see
them, and a child-row edit would change the aggregate without moving the version.
That is the exact hole `docs/timestamps.md` cites for making `updatedAt` a
trigger rather than an application assignment, and the version has it too.

Under the trigger, a rollup update simply omits `version`, so `NEW."version"`
equals `OLD."version"`, the check passes, and the trigger increments anyway. The
counter tracks every write to the row, whatever path wrote it.

**A predicate fails silently.** `update … from (values …)` reports only a total
affected count, so a losing row is a no-op indistinguishable from "no changes",
with no way to tell which row conflicted. A precondition is worth having only if
its violation is visible. `raise` names the row and aborts.

## What the check means

The rule is "the version you send must equal the version currently stored":

| Sends | Stored | Result |
| --- | --- | --- |
| `3` | `3` | Passes, stored becomes `4`. |
| `3` | `4` | `raise`, nothing written. |
| omitted | `4` | `raise` (null is distinct from `4`). |
| omitted | `4`, via the rollup | Passes, stored becomes `5`. |

The last row is the rollup: it does not claim a version, so it never conflicts,
but it still advances the counter. Any write moves the version, so a client
holding a pre-rollup version is told its view is stale.

A raw SQL update that deliberately sets `version` to the stored value would also
pass — the guard protects callers that opt in, which in practice means the
generated repositories.

## Insert vs update

The version has a different lifecycle from both timestamps, and it is the one
column that is *defaulted yet written*:

| Path | `version` | Why |
| --- | --- | --- |
| insert | omitted | `default 0` supplies the first revision. |
| update | written as `data."version"` | It carries the caller's precondition into the trigger. |
| rollup update | omitted | Raw SQL; the trigger advances it without a claim. |

This is the first exception to "a defaulted column is never written"
(`docs/repositories.md`), so `packages/backend/scripts/generate-repositories.ts`
builds a different column set per statement: the insert excludes everything with
a default, while the patch includes a defaulted column that is flagged `version`.

The repository sends the caller's version in the `set` list rather than leaving
it to the trigger, because the trigger's check is against `NEW`. If the update
did not set the column, `NEW."version"` would always equal `OLD."version"` and
the precondition would never fire.

Because an update is a patch (`docs/repositories.md`), the version is one of the
two columns the patch type makes mandatory — the other is the primary key. A
caller cannot build a patch that omits the precondition.

## Gotchas

- **A conflict aborts the statement and the transaction.** For a multi-row
  `update…`, one stale row rolls back all of them. This is intended — a batch is
  one logical write and retrying it is the caller's job — but it is a change from
  "skip the losing row".
- **The rollup bumps the version.** Editing an `invoice_row` reassigns
  `invoice.netAmount`, which fires the invoice's version trigger. A user editing
  the invoice in that window gets a conflict. Correct, since their `totalAmount`
  is stale, but version changes are not one-to-one with user edits.
- **`JSON.stringify` throws on `bigint`.** This is the objection
  `docs/primitives.md` raises against bigint, and it applies here. Nothing in
  `packages/` serializes a spec object today, but the first HTTP or RPC boundary
  to do so will throw. Serializing with a replacer, or converting at that
  boundary, is the fix.
- **The first version is not returned.** Every repository function returns
  `Promise<void>` and reading is deliberately not generated
  (`docs/repositories.md`), so `createCustomer` does not tell the caller that the
  row is now at version `0`. Learning it takes a `RETURNING` or a read path.
- **`@inlined Customer` leaks `customerVersion`.** Inlining flattens every scalar
  field, so `invoice_sent` gains a nullable `customerVersion int8` — the
  customer's revision at send time, alongside the `customerCreatedAt` and
  `customerUpdatedAt` that already leak. There is no per-field opt-out.
- **The guard is SQL, so it is not type-checked.** A wrong comparison or a
  mistyped column surfaces when the DDL runs, not at lint time — the same class
  of risk as a `@default` expression.
- **Nothing behavioural tests the trigger.** Per `docs/testing.md`, trigger
  semantics are deliberately out of scope, so the generator tests assert the
  emitted text and `schema.test.ts` asserts only that the file executes. A
  subtly wrong trigger would pass every test.

## Deliberately not implemented

- **The version on the snapshots.** Above.
- **Returning the new version from `create`/`update`.** See the gotcha.
- **A conflict-resolution strategy.** The trigger reports; retrying, merging, or
  surfacing a conflict to a user is the caller's decision.
- **Deletes checking a version.** `deleteCustomer` keys on the primary key only.
  Deleting a row someone else has just updated is a real race, but a delete is
  idempotent enough that it was left out.

## Wiring

1. `packages/spec/src/primitives/Version.ts` defines the brand; `@version` and
   `@default 0` go on the field.
2. `packages/backend/scripts/spec-model.ts` maps `Version` to `int8` and sets
   `Column.version` from the tag.
3. `packages/backend/scripts/generate-postgres-schema.ts` emits the column and
   `renderVersionTrigger`.
4. `packages/backend/scripts/generate-repositories.ts` omits the column on insert
   and writes it on update.
5. `packages/spec/scripts/lint-spec.ts` requires `@version` on a `Version` field,
   at most one per interface, exclusive with `@generated` and `@computed`.

See `docs/timestamps.md` for the trigger-and-default pattern this column follows.
