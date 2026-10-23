# Optionality

A field's `?` mirrors its column's nullability, and nothing else:

- **`not null` column → required field.** No `?`.
- **Nullable column → optional field.** `?`.

The spec is the shape a caller reads, and reading is what most of the
application does. A `not null` column that appears optional in the spec is a lie
the type system repeats at every call site: the caller has to prove a value is
there that was never absent.

## The database filling a column does not make the field optional

Several tags make a column `not null` and supply a fallback when a write omits
the field:

- `@createdAt` and `@updatedAt` — `default now()`, and a generated write falls
  back to it. See `docs/timestamps.md`.
- `@pgDefault` — the expression fills the column when a statement omits it.
  The expression may come from the field's type, so every `UUIDv7` column has a
  default unless its field overrides or clears it. See `docs/primitives.md`.
- `@version` — `default 0` supplies the first revision. See `docs/versioning.md`.

The column is `not null` because a value is guaranteed, so the field is
required. The field says what the row has; the tags say what a write does when
the field is absent.

## The create is a different shape

Required in the spec does not mean required on the wire. A create relaxes each
field whose column has a fallback:

- A clock column and a defaulted `@version` stay in `<Entity>Insert`, but
  optional: the schema `.partial()`s them and the statement writes the supplied
  value, or the column default when the row omits it.
- A `@pgDefault` field is relaxed the same way.

So a defaulted `status` column is required in its entity and optional in
`MessageInsert`, without one contradicting the other. The same applies to `createdAt`, `updatedAt`, and a
defaulted `version`, which a seed or a backfill may supply. See
`docs/validation.md` and `docs/repositories.md`.

## What stays optional

A field whose column is nullable, which is how `@computed` values start life:

- `Widget.subtotal`, `Widget.surcharge`, `Widget.total` — computed from
  the rows, so absent until there are rows. A trigger propagates `null` rather
  than inventing a zero.
- `WidgetRow.subtotal` and friends, the same way.
- Plain optional data: `Account.externalId`, `Widget.notes`. Nullable, because
  an account may have no external identifier.

## Writing one back

The read type is `T | undefined`, and a write takes the same two states meaning
different things. A create writes a nullable column whether the caller omits the
field or sends it, so `undefined` and `null` are one request there. A patch tells
them apart: omitting the field leaves the stored value alone, and `null` clears
the column, which is the only way to write a null
(`docs/repositories.md`).

An upsert takes both like a create and stores them like one — it writes the row
whole, so omitting the field and sending `null` are again one request. It accepts
`null` anyway, because a caller holding a row from a form or another JSON surface
carries `null` where a spec may carry an absent field.

## Generation

`scripts/backend/postgres-model.ts` makes a defaulted column `not null`
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
  entity, so it carries `createdAt`, `updatedAt`, and `version`, and the
  generated insert stores the declared values. See `docs/mockdata.md`.
