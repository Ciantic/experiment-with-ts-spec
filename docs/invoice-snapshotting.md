# Invoice snapshotting

`packages/spec/src/domain/InvoiceSent.ts` is an invoice as issued. `Invoice` is the working
draft; `InvoiceSent` is a frozen copy made at send time. The column mechanics of
copying an entity come from the `@inlined` tag — see `docs/spec-annotations.md`.

## Why a second model

An issued invoice is a legal document: what the customer received must not change
when some referenced record does. The draft already freezes amounts
(`@pgTrigger`, see `docs/spec-annotations.md`), but a live `@relation
Customer` still re-renders every past invoice when an address or a VAT number is
edited. The same holds for `Seller`, the company that issued it. `InvoiceSent`
closes that gap by copying both parties at send time.

## Shape

- `invoice_sent` copies the header and inlines both parties. `@inlined` on
  `customer` becomes `customerId`, `customerName`, `customerEmail`, … columns on
  the same table, with no foreign key; `@inlined` on `seller` does the same for
  the issuer.
- `invoice_sent_row` copies the line items.
- `invoiceId` links back to the draft, for traceability. It is the only foreign
  key out of the snapshot.
- `number` is `@unique`, as on the draft. When a number is issued — at draft
  creation or at send — is a separate decision.
- `language` is required on the snapshot even though it is optional on the draft,
  like `number`: the send resolves it (override, else draft, else a party
  default) and the frozen document records what was rendered.

## The draft is partial, the snapshot is complete

`Invoice` is a draft: a form the user is still filling in. Field optionality
follows from that. Only the identity keys are required; everything a draft may
not have yet is optional.

- Required: `Invoice.id`, `InvoiceRow.id`, and `InvoiceRow.invoiceId`. A row
  always belongs to an invoice.
- Optional: `number`, `issueDate`, `dueDate`, `netAmount`, `taxAmount`,
  `totalAmount`, `rows`, `notes`, and the row's `description`, `quantity`, `unit`,
  `unitPrice`, `taxRate`, and amounts. `customer`, `createdAt`, `updatedAt`, and
  `version` were already optional (`docs/timestamps.md`, `docs/versioning.md`).
- `InvoiceSent` and `InvoiceSentRow` are the opposite: frozen at send time, so
  every field stays required. A sent invoice is complete by definition.

Optionality is nullability, so the optional draft columns are nullable in
`invoice` and `invoice_row`; `id` stays `not null` as the primary key, and
`createdAt`/`updatedAt`/`version` stay `not null` because their `@pgDefault` fills
them even though the field is optional.

Two consequences worth naming:

- **`number` is `@unique`, and nulls do not collide.** Postgres allows any number
  of rows with a null key, so unnumbered drafts coexist until one is issued.
- **The amounts are `@computed` and optional together.** With no rows, or with
  rows whose inputs are null, the trigger expression propagates null rather than
  inventing a zero — an uncomputed total is absent, not zero.

## The frozen-copy rule

The snapshot copies values; it does not recompute them from the draft. Two
consequences:

- `invoice_sent_row` repeats the row amounts' `@pgTrigger` statements, so they
  are still rounded by SQL. The inputs are copied too, so recomputing reproduces
  the sent values.
- `invoice_sent`'s totals are plain columns, copied from the draft. A `@pgRollup`
  could maintain them instead, with a statement written for `InvoiceSentRow`, but
  the totals are copied, and a rollup is the fix when they need to be maintained
  in SQL.

## Gotchas

- **There is no embedded or nested type.** The generator has no way to model a
  `Customer` value object; `@inlined` flattens the target's scalar fields into the
  parent table. A snapshot cannot nest the object as one column.
- **`@inlined` drops `@unique`.** Inlining an entity with a unique field would
  otherwise make that value unique across all sent invoices.
- **The snapshot is not enforced immutable.** No trigger or grant blocks
  `update`/`delete` on `invoice_sent`. Freezing is a convention until one exists.
- **Rows are copied, not referenced.** `invoice_sent_row` does not point at
  `invoice_row`; that is deliberate, so editing a draft after sending cannot
  alter the sent document.
- **`customer` is optional.** Following the draft model, the field is
  `customer?: Customer`, so every inlined customer column is nullable. A sent
  invoice with no customer is representable; requiring one is a separate
  constraint.
- **The snapshot inherits the parties' timestamps and language.** `@inlined` on
  the two parties flattens every scalar field, so
  `customerCreatedAt`, `customerUpdatedAt`, `sellerCreatedAt`,
  `sellerUpdatedAt`, `customerLanguage`, and `sellerLanguage` land on
  `invoice_sent` too. See `docs/timestamps.md` and `docs/invoice-sending.md`.

## Deliberately not implemented

- **Immutability triggers.** A `before update or delete … raise exception` pair
  would enforce the freeze in the database.
- **A dedicated aggregate registry.** Totals are copied, not rolled up (above).
- **Payment and status.** No status field is modelled. Where paid/overdue lives —
  on the draft or on the snapshot — is undecided, and it must not be added back to
  `Invoice` until it is.
- **Re-sends and credit notes.** Whether `InvoiceSent` is 1:1 with `Invoice` or
  1:many (a re-send, a correction) is undecided. The current shape allows many.
