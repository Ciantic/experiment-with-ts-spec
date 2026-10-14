# Tenancy

`Tenant` is the root of the data graph: every other entity declares a `tenantId`
pointing at it, except `Translation` and `AuditLog`, which are global. Two
annotations carry that, and they are independent: one scopes the **reads** of a
tenanted entity, the other scopes its **links** to other tenanted entities.

```ts
/**
 * @fieldName Tenant ID
 * @queryFilter required
 * @foreignKey Tenant
 * @widget text
 */
tenantId: TenantId;
```

## Reads: `@queryFilter required`

Marking `tenantId` a required filter makes every read of the entity name it, so a
read cannot list another tenant's rows by omitting a filter. The requirement is
enforced in four places, from the type down to the resolver — see
`docs/queries.md`. `Tenant`, `Translation`, and `AuditLog` have no `tenantId` and
so nothing to require; a read of them is unscoped.

That alone is not enough: it scopes what is *read*, not what is *written*.

## Links: `@foreignKey <Entity> scope=<field>`

A foreign key names one column, so `@foreignKey Invoice` on `invoiceId` says the
row points at an invoice and says nothing about the tenant. Writes go through the
generated repositories, but nothing stops `tenantId` and `invoiceId` from
disagreeing, which would produce a row that one tenant can read and no tenant
owns.

`scope=<field>` makes the reference **composite**: the pair must exist on the
target.

```ts
/**
 * @fieldName Invoice
 * @foreignKey Invoice scope=tenantId
 * @widget text
 */
invoiceId: InvoiceId;
```

```sql
constraint "invoice_row_tenantId_invoiceId_fkey"
    foreign key ("tenantId", "invoiceId") references "invoice" ("tenantId", "id")
```

The scope names a field of the referencing interface, and the target must
declare a field of the same name; the generator covers the pair with the unique
constraint a composite reference needs
(`constraint "invoice_tenantId_id_key" unique ("tenantId", "id")`). Nothing else
changes: the repository generators write the same columns, and a `@relation`
still joins through the target's key, because the key alone identifies the row.

This is a **database** constraint rather than a check in generated SQL, so it
holds for every writer — the repositories, a batch, a migration, `psql`. It also
guards the other direction: moving a parent's tenant out from under a child is
refused. And it composes: `invoice_sent_row` is scoped to `invoice_sent`, which
is scoped to `invoice`, so the chain holds two levels deep without a third rule.

Five relations carry a scope: `InvoiceRow` → `Invoice`, `InvoiceSentRow` →
`InvoiceSent`, `InvoiceSent` → `Invoice`, `Invoice` → `Customer`, and `Invoice` →
`Seller`. The `tenantId` keys into `Tenant` are not scoped: `Tenant` is the root,
so there is no second column to agree with.

## Rules

- The scope field is **required**. `MATCH SIMPLE`, the Postgres default for a
  composite key, matches nothing when any column of the pair is null, so a
  nullable scope would silently switch the check off. The linter reports it.
- The scope field **may not be the referencing field itself**, which lints
  cleanly but cannot be satisfied.
- The target must declare a field of the same name, so the pair can be matched.
  The linter checks the referencing interface; the table model checks the target,
  since that needs the other interface's fields (`docs/spec-annotations.md`).
- `onDelete=setNull` **may not** accompany a scope. Postgres nulls every column of
  a composite key on delete, and the scope is required, so the delete could never
  succeed. A partial `set null (column)` list is not generated.
- The referencing column may still be optional. A null `customerId` means "no
  customer", and the pair is not matched — which is the intent, not a gap.

## What this does not cover

- **A scope that is not a key lookup.** `invoice_sent."customerId"` carries no
  foreign key at all: the customer is copied into the row as a snapshot
  (`docs/invoice-snapshotting.md`), so there is no reference to constrain.
- **Authorization.** Nothing reads a principal. A constraint stops two tenants
  from being linked; it does not stop a caller from naming one tenant and reading
  another's rows in a filter. Postgres RLS with a per-request executor is the
  mechanism for that, and it is not implemented — see `docs/rest-api.md`.
