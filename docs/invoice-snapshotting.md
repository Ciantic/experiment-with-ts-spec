# Invoice snapshotting

`spec/domain/InvoiceSent.ts` is an invoice as issued. `Invoice` is the working
draft; `InvoiceSent` is a frozen copy made at send time. The column mechanics of
copying an entity come from the `@inlined` tag — see `docs/spec-annotations.md`.

## Why a second model

An issued invoice is a legal document: what the customer received must not change
when some referenced record does. The draft already freezes amounts
(`storage=stored`, see `docs/spec-annotations.md`), but a live `@relation
Customer` still re-renders every past invoice when an address or a VAT number is
edited. `InvoiceSent` closes that gap by copying the customer at send time.

## Shape

- `invoice_sent` copies the header and inlines the customer. `@inlined Customer`
  becomes `customerId`, `customerName`, `customerEmail`, … columns on the same
  table, with no foreign key.
- `invoice_sent_row` copies the line items.
- `invoiceId` links back to the draft, for traceability. It is the only foreign
  key out of the snapshot.
- `number` is `@unique`, as on the draft. When a number is issued — at draft
  creation or at send — is a separate decision.

## The frozen-copy rule

The snapshot copies values; it does not recompute them from the draft. Two
consequences:

- `invoice_sent_row` reuses `rowFormulas`, so its amounts are still rounded by
  SQL. The inputs are copied too, so recomputing reproduces the sent values.
- `invoice_sent`'s totals are plain columns, copied from the draft. The aggregate
  fragments in `invoiceFormulas` (in `postgres/formulas.ts`) cannot be reused:
  they hardcode the child key
  `"invoiceId"` and `update "invoice"`, so a rollup would target the wrong table
  and column. A dedicated `invoiceSentFormulas` registry, spelling
  `"invoiceSentId"` and `update "invoice_sent"`, is the fix when the totals need
  to be maintained in SQL rather than copied.

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

## Deliberately not implemented

- **Immutability triggers.** A `before update or delete … raise exception` pair
  would enforce the freeze in the database.
- **A dedicated aggregate registry.** Totals are copied, not rolled up (above).
- **Payment and status.** No status field is modelled. Where paid/overdue lives —
  on the draft or on the snapshot — is undecided, and it must not be added back to
  `Invoice` until it is.
- **Re-sends and credit notes.** Whether `InvoiceSent` is 1:1 with `Invoice` or
  1:many (a re-send, a correction) is undecided. The current shape allows many.
