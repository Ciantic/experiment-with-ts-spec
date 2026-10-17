# Soft delete

Soft deletion needs no tag. A row's deletion moment is an ordinary nullable
column, `update` writes it, and a filter default hides the deleted rows from a
read that does not ask for them.

`Invoice` declares it in the spec:

```ts
/**
 * The moment the invoice was trashed; null while it is live.
 *
 * @fieldName Deleted at
 * @deletedAt
 * @queryFilter default=isNull
 * @widget date
 */
deletedAt?: Date;
```

## The column

The field is optional, so the column is a plain nullable `timestamptz` with no
default and no trigger. It is an ordinary field in every other respect: a create
may set it, a patch may set it to a moment or back to `null`, and a read may
select it. No special operation exists for it — there is no `trash` or `restore`.

## The marker

`@deletedAt` changes no generation. It records which field is the deletion
moment and makes the linter check the shape a reader depends on:

- the field is optional, so the column is nullable;
- its type is `Date`;
- it carries `@queryFilter default=isNull`, so a read that omits the filter sees
  live rows only;
- it is a scalar field, not a branch, and the tag takes no value.

The tag is reserved for a future mechanism. Until then removing it changes
nothing but the lint finding, and `@queryFilter default=isNull` alone provides the
behaviour.

## Reads default to live rows

`@queryFilter default=isNull` makes the filter match `is null` when a read omits
it. Every read of the entity therefore returns live rows unless it names the
filter:

```ts
const live = await queryInvoice(db, { filter: { tenantId: [tenantId] }, select: { number: true, deletedAt: true } });
```

A read that names `deletedAt` overrides the default. A set cannot say "is not
null", so a read of deleted rows uses the filter's null test:

```ts
const deleted = await queryInvoice(db, {
    filter: { tenantId: [tenantId], deletedAt: { isNotNull: true } },
    select: { number: true, deletedAt: true },
});
```

`{ isNull: true }` is the explicit spelling of the default, and a where clause
such as `where: { deletedAt: { isNotNull: true } }` works too when the field
whitelists `@queryWhere`; both null tests take `true` and bind no parameter. A
`where` condition on a field overrides that field's filter default.

## Trash and restore are updates

A trash is a patch of the version the caller holds; a restore is the same patch
with `null`:

```ts
await updateInvoice(db, [{ id, version, deletedAt: new Date() }]);
await updateInvoice(db, [{ id, version, deletedAt: null }]);
```

The optimistic-lock rules are the ordinary ones (`docs/versioning.md`): a stale
version rejects the call with `40001` (a `409` over REST), and an omitted
`deletedAt` leaves the column alone, so a patch that changes `notes` does not
un-delete a row.

## Gotchas

- **Uniqueness covers every row.** A trashed row keeps its values, so a
  `@unique` column such as `Invoice.number` stays taken until the row is deleted
  for good. A partial unique index over live rows is not generated.
- **A trashed row is still writable.** `update` and `delete` address a row by key
  whatever its state, and a foreign key may point at it. Hiding is a read rule,
  not a write lock.
- **The default applies to branches.** A `@children` or `@relation` branch reads
  through the same resolver, so a branch over the entity hides its deleted rows
  unless the branch names the filter — a null test included — or compares the
  field (`docs/queries.md`).
- **Purging is a delete.** `delete<Entity>` removes the row for good; nothing
  purges trashed rows on a schedule.
- **An actor is not modelled.** Who trashed a row (`deletedBy`) is a separate
  field, as with `updatedBy` (`docs/timestamps.md`).
