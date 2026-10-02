# Timestamps

Every mutable domain model carries `createdAt` and `updatedAt`, both `Date`
(`timestamptz`):

- `Customer` — `createdAt`, `updatedAt`
- `Invoice` — `createdAt`, `updatedAt`
- `InvoiceRow` — `createdAt`, `updatedAt`

Both are supplied by the database through a single tag each, rather than through
`@generated`/`@computed` plus `@default`. The tags are self-contained because the
pairing of default and trigger is fixed and easy to get wrong by hand.

## `createdAt` — a database default

```ts
/**
 * The moment the customer record was created.
 *
 * @fieldName Created at
 * @createdAt
 * @widget date
 */
createdAt?: Date;
```

`@createdAt` writes a column default:

```sql
"createdAt" timestamptz not null default now()
```

Three things follow:

- **The field is optional.** The database fills it, so a caller need not supply
  one. The tag also forces the column `not null` even when the field is optional
  — the default guarantees a value, so a nullable column would be a lie.
- **The repository does not write it.** The tag excludes the column from the
  generated `insert` and `update`.
- **It is set once.** A default only applies when a column is omitted, and the
  repository always omits it, so `createdAt` is never rewritten by an update.

## `updatedAt` — a default *and* a trigger

```ts
/**
 * The moment the customer record was last updated.
 *
 * @fieldName Updated at
 * @updatedAt
 * @widget date
 */
updatedAt?: Date;
```

`@updatedAt` emits both halves, because the two answer different questions:

- **The column default is the insert path.** On insert there is no previous write
  to preserve, so the value is simply now().
- **The trigger is the update path.** Postgres has no
  `ON UPDATE CURRENT_TIMESTAMP` (that is MySQL), so a column default cannot
  express "refresh on every write" — it fires only on insert. The trigger does.

The emitted DDL is both:

```sql
"updatedAt" timestamptz not null default now(),
```

```sql
create function "customer_compute"() returns trigger as $$
begin
    NEW."updatedAt" := now();
    return NEW;
end;
$$ language plpgsql;

create trigger "customer_compute" before insert or update on "customer"
    for each row execute function "customer_compute"();
```

## Why both, rather than either alone

A `before insert` trigger runs *after* defaults are applied, so on insert the
trigger's assignment wins and the default is never read. It would be a mistake to
conclude that the default is therefore redundant.

It is not, for two reasons:

- **The two cannot disagree.** `default now()` and `NEW."updatedAt" := now()` in
  the same transaction both resolve to transaction time, so they produce the
  identical instant. Verified against PGlite: an insert that omits the column
  stores a value equal to `createdAt`, which the trigger filled the same way.
- **The default covers paths where the trigger does not run.** Triggers can be
  disabled for a bulk load or a migration (`ALTER TABLE ... DISABLE TRIGGER`), and
  `ALTER TABLE ... ADD COLUMN ... DEFAULT now()` backfills existing rows. Without
  the default, those paths would either fail `not null` or leave a stale value.

The redundancy is cheap and self-consistent, so `@updatedAt` emits both. The
default documents the column's guarantee at the schema level; the trigger
maintains it.

`now()` is written by the generator: the clock tags are the only place the
spec declares a timestamp, so there is no expression to name and no registry to
consult. That is why `packages/spec/src/domain/Timestamp.ts` and its
`TimestampFormula` union no longer exist — see `docs/spec-annotations.md`.

`updatedAt` is optional for the same reason `createdAt` is: the column has a
default, so the repository never writes it and the caller never supplies it.
Because the trigger fires on every write, it overwrites whatever a hand-written
statement sent.

## Why a trigger fixes the rollup

The earlier version of this design had the application assign `updatedAt`, which
left a real hole: the invoice rollup triggers run
`update "invoice" set "netAmount" = …` directly in SQL when a child row changes.
An application-assigned column was not part of those statements, so editing an
`invoice_row` changed an invoice without touching its `updatedAt`.

The invoice's own `before update` trigger closes that hole: the rollup's `update`
fires it, which refreshes `updatedAt`. The rollup and the clock tag chain, and
the chain is load-bearing. (The invoice's `totalAmount` is a virtual generated
column, so it needs no place in that trigger at all — it recomputes on read.)

## Why not the snapshots

`InvoiceSent` and `InvoiceSentRow` carry neither field. They are frozen copies
(`docs/invoice-snapshotting.md`): `sentAt` already records when the document was
issued, and an `updatedAt` on a document that is not supposed to change states a
contradiction the model should not express.

They do inherit `customerCreatedAt` and `customerUpdatedAt`, because
`@inlined` flattens *every* scalar field of the target. Those are the
customer's timestamps as of send time — correct snapshot behaviour, but audit
columns about the customer rather than the invoice. There is no per-field opt-out
from `@inlined`.

## Gotchas

- **A clock tag is exclusive with `@default`.** `@createdAt`/`@updatedAt` supply
  `default now()` themselves, so writing `@default` beside one is a lint finding.
  `@default` on its own is still valid, and a `@computed` field may carry one.
- **The default expression is written verbatim.** `@default now()` becomes
  `default now()`. It is SQL, not a formula name, so it is not validated and a
  typo surfaces when the DDL runs, not at lint time. The clock tags are the
  exception: their `now()` comes from the generator, not from a tag value.
- **A defaulted column is invisible to the repository.** Excluding it is the
  point, but it means the generated `insert` cannot set it even deliberately.
  Writing one requires raw SQL. This applies to both timestamps.
- **A trigger can be bypassed.** `ALTER TABLE ... DISABLE TRIGGER` during a bulk
  load leaves `updatedAt` at its default rather than the write time. That is the
  case the default is there to keep sane, but the value will not be per-write.
- **Deleting a row does not touch anything.** There is no parent to notify, so a
  delete does not bump any `updatedAt`.
- **`now()` is transaction time.** Every statement in one transaction sees the
  same value, so two writes in a single transaction get identical timestamps.
  Use `clock_timestamp()` if wall-clock ordering within a transaction matters.

## Deliberately not implemented

- **Soft delete (`deletedAt`).** Deletion is a real `delete`.
- **Optimistic locking via `updatedAt`.** Not this column: `now()` is transaction
  time, so two writes in one transaction share a value and a stale read could
  still match. A separate monotonic counter was added instead; see
  `docs/versioning.md`.
- **Timestamps on the snapshots.** Above.
- **An actor column.** Who made the change (`updatedBy`) is not modelled.
