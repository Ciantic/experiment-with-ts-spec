# Timestamps

A field carrying `@createdAt` or `@updatedAt` is a clock, and its column is
`Date` (`timestamptz`), not null. A mutable entity declares one of each — the
`Widget` example does — so a row records when it appeared and when it last
changed.

Both are declared through a single tag each, rather than through `@computed`
plus `@pgDefault`. A tag supplies the column's default, and the generated writes
use that default as the fallback for a row that omits the field.

## `createdAt` — written once

```ts
/**
 * The moment the account record was created.
 *
 * @fieldName Created at
 * @createdAt
 * @widget date
 */
createdAt: Date;
```

`@createdAt` writes a column default:

```sql
"createdAt" timestamptz not null default now()
```

Three things follow:

- **The field is required.** A row always has the column, since the default
  guarantees a value, so the field is required and the column `not null`. A
  nullable column would be a lie. See `docs/optionality.md`.
- **A create writes it when supplied.** The insert carries the value, and falls
  back to the column default when the row omits it. A supplied value is what a
  backfill or a fixture needs.
- **It is set once.** No patch writes it, and an upsert's conflict path leaves
  the stored value alone. An insert may carry any value; a later write cannot
  change it.

## `updatedAt` — refreshed by every write

```ts
/**
 * The moment the account record was last updated.
 *
 * @fieldName Updated at
 * @updatedAt
 * @widget date
 */
updatedAt: Date;
```

The tag emits the same column default:

```sql
"updatedAt" timestamptz not null default now()
```

Every generated write refreshes it:

- **create** writes a supplied value, or `now()` when the row omits it.
- **patch** writes a supplied value, or `now()` when the patch omits it.
- **upsert** writes the value it carries on the insert path; its conflict path
  writes a supplied value, or `now()` when the row omits it.

A supplied value therefore survives, and an omitted one moves the clock. That is
what lets a test or a backfill restore a historical instant without disabling a
trigger.

## No clock triggers

The generated DDL carries no trigger for either clock. A `BEFORE` row trigger
runs after column defaults are applied, so on insert it cannot distinguish a
value the caller supplied from a value the default filled in; assigning the clock
there would overwrite both. Postgres also does not expose the `SET` list of an
`UPDATE` to a trigger, so a trigger cannot tell an omitted column from one set to
its stored value.

The generated statement knows which fields a row carries. It writes the value
when the row supplies one and falls back to `now()` otherwise, which is the same
choice the database would make, made where the information still exists.

`now()` is written by the generator: the clock tags are the only place a
timestamp is declared, so there is no expression to name and no registry to
consult. See `docs/spec-annotations.md`.

## Cross-table writes

A parent row's aggregate fields are maintained by `@pgTrigger` statements that
run raw SQL when a child row changes:

```sql
update "widget" set "subtotal" = …, "updatedAt" = now(), "version" = "version" + 1
```

Those statements do not go through the generated `update`, so they maintain the
clock and the version themselves. Any hand-written statement that changes a
table carrying them must do the same; nothing in the database does it on the
writer's behalf. (The `widget`'s `total` is a virtual generated column, so
it needs no place in that trigger at all — it recomputes on read.)

## Why not the snapshots

A snapshot entity — one copied at write time rather than referenced — carries
neither field. `WidgetSnapshot` and `WidgetSnapshotRow` are frozen when they are
written: `frozenAt` already records when the snapshot was taken, and an
`updatedAt` on a document that is not supposed to change states a contradiction
the model should not express.

They do inherit `accountCreatedAt` and `accountUpdatedAt`, because
`@inlined` flattens *every* scalar field of the target. Those are the
account's timestamps as of the snapshot — correct snapshot behaviour, but audit
columns about the account rather than the widget. There is no per-field opt-out
from `@inlined`.

## Gotchas

- **A clock tag is exclusive with `@pgDefault`.** `@createdAt`/`@updatedAt` supply
  `default now()` themselves, so writing `@pgDefault` beside one is a lint finding.
  `@pgDefault` on its own is still valid, and a `@computed` field may carry one.
- **The default expression is written verbatim.** `@pgDefault now()` becomes
  `default now()`. It is SQL, not a formula name, so it is not validated and a
  typo surfaces when the DDL runs, not at lint time. The clock tags are the
  exception: their `now()` comes from the generator, not from a tag value.
- **A raw update does not refresh `updatedAt`.** Nothing in the database assigns
  it, so a hand-written `update` that omits the column leaves the stored value
  unchanged. The generated `update` and `upsert` do refresh it.
- **A create may set both clocks.** They are ordinary insertable fields, so a
  caller or a seed can supply a historical instant. An omitted one takes the
  column default.
- **Deleting a row does not touch anything.** There is no parent to notify, so a
  delete does not bump any `updatedAt`.
- **`now()` is transaction time.** Every statement in one transaction sees the
  same value, so two writes in a single transaction get identical timestamps.
  Use `clock_timestamp()` if wall-clock ordering within a transaction matters.

## Deliberately not implemented

- **Optimistic locking via `updatedAt`.** Not this column: `now()` is transaction
  time, so two writes in one transaction share a value and a stale read could
  still match. A separate monotonic counter fills that role; see
  `docs/versioning.md`.
- **Timestamps on the snapshots.** Above.
- **An actor column.** Who made the change (`updatedBy`) is not modelled.
- **A trash marker tag.** A row's deletion moment is an ordinary nullable
  `deletedAt` field with `@queryFilter default=isNull`; `@deletedAt` marks it but
  changes no generation of its own. See `docs/soft-delete.md`.
