# Optionality

A field's `?` mirrors its column's nullability, and nothing else:

- **`not null` column → required field.** No `?`.
- **Nullable column → optional field.** `?`.

The spec is the shape a caller reads, and reading is what most of the
application does. A `not null` column that appears optional in the spec is a lie
the type system repeats at every call site: the caller has to prove a value is
there that was never absent.

## The database filling a column does not make the field optional

Several tags make a column `not null` while keeping it out of every write:

- `@createdAt` and `@updatedAt` — `default now()`, and the trigger assigns each
  write. See `docs/timestamps.md`.
- `@pgDefault` — the expression fills the column when a statement omits it.
- `@version` — `default 0` supplies the first revision. See `docs/versioning.md`.

The column is `not null` because a value is guaranteed, so the field is
required. The field says what the row has; the tags say who supplies it.

## The create is a different shape

Required in the spec does not mean required on the wire. A create carries the
columns the database does not own:

- A clock column and a defaulted `@version` are dropped entirely
  (`isInsertable`).
- Another `@pgDefault` field stays, but relaxed: `<Entity>Insert` makes it
  optional and its schema `.partial()`, and the statement writes the `default`
  keyword in that row's slot when the caller omits it.

So `Email.status` is required and `EmailInsert["status"]` is optional, without
one contradicting the other. See `docs/validation.md` and
`docs/repositories.md`.

## What stays optional

A field whose column is nullable, which is how `@computed` values start life:

- `Invoice.netAmount`, `Invoice.taxAmount`, `Invoice.totalAmount` — computed
  from the rows, so absent until there are rows. A trigger propagates `null`
  rather than inventing a zero.
- `InvoiceRow.netAmount` and friends, the same way.
- Plain optional data: `Customer.eInvoiceAddress`, `Invoice.notes`. Nullable,
  because a customer may have no e-invoice address.

## Generation

`packages/backend/scripts/postgres-model.ts` makes a defaulted column `not null`
whatever the field says, and a generator reads the tag, never the field name —
so adding an entity never edits a generator. A field is therefore optional
exactly when its column is nullable.

`lint:spec` checks the direction a tag can force: a tag whose column is
`not null` — `@primaryKey`, `@pgDefault`, `@createdAt`, `@updatedAt`, `@version`
— may not sit on an optional field. The other direction is not reported, since no
lint rule reads the DDL and the interface together: a required field on a
nullable column passes.

## Gotchas

- **A selected key is still `?`, even when the field is required.** `Selected`
  marks every key it projects optional, because selection omits what the caller
  did not ask for. It is the selected *key that is optional*, not the value: a
  required field's column is `not null`, so the value is always present when it
  is selected. See `docs/queries.md`.
- **A `null` column and an absent key look the same on the wire.** The resolver
  drops a `null` scalar, so an optional field's value is missing rather than
  `null`; a required field's never is.
- **Mock data declares the required fields anyway.** A row is typed as the
  entity, so it carries `createdAt`, `updatedAt`, and `version` even though the
  insert omits those columns. See `docs/mockdata.md`.
