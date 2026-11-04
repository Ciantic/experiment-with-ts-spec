# Tenancy

A spec may declare one tenant root: the entity that scoped entities point at with
a `tenantId`, save the global ones. In the example, the root is `Tenant`, and
`Locale` and `LogEntry` are its global entities. Three annotations carry that:
two on the interface say what it is, and one on a reference says what it must
agree with. The linter holds all three together.

```ts
/**
 * @entity
 * @tenant
 * @pgTable tenant
 */
export interface Tenant { … }

/**
 * @entity
 * @tenantOwned
 * @pgTable widget
 */
export interface Widget {
    /**
     * @fieldName Tenant ID
     * @queryFilter required
     * @foreignKey Tenant
     * @widget text
     */
    tenantId: TenantId;
}

/**
 * @entity
 * @tenantOwned optional
 * @pgTable email
 */
export interface Email {
    /**
     * @fieldName Tenant ID
     * @queryFilter
     * @foreignKey Tenant
     * @widget text
     */
    tenantId?: TenantId;
}
```

The first interface is scoped to one tenant. The second is *optionally*
scoped: a row with a tenant belongs to it, and a row with a null tenant belongs
to no tenant at all. The `optional` word on the tag is what makes that intent
explicit; a bare optional field does not.

## The root: `@tenant`

`@tenant` is a bare marker on the interface that owns the graph, and the linter
reports a second one: one root keeps every scope unambiguous. The root is never
`@tenantOwned`, since there is no higher scope for it to agree with, and a
reference to it is never scoped.

The root's single `@primaryKey` field declares the tenant id type. Every
`@tenantOwned` column must declare exactly that type, which the linter checks, so
the generated guard and tenant lookup name one canonical type instead of indexing
each entity. The parser resolves it once into `SpecModel.tenantIdType`.

`Tenant` is the only interface in the example that carries the tag.

## Ownership: `@tenantOwned [column] [optional]`

`@tenantOwned` scopes the interface to the root. The column defaults to the
interface's one link to the root, so the tag alone is enough: the linter takes
the field carrying `@foreignKey Tenant` — the link is what makes it a tenant
column rather than a bare id — and checks that it is a scalar column with the
root key's type. Naming the column, `@tenantOwned tenantId`, is for an interface
with more than one such link: a bare tag there is a finding, since the linter
cannot tell which column scopes the interface. An interface that declares
neither the tag nor a link to the root is global, which is what `Locale` and
`LogEntry` are.

The word `optional` says some rows have no tenant. It must agree with the field:
an `optional` tag needs an optional field, and an optional field needs the tag,
so a nullable tenant column is never an accident. The tag is also the only place
the distinction appears: the column is nullable, the read type carries
`tenantId?: TenantId`, and every generated write accepts a null tenant.

An unowned row is a **global** row. It is governed by the entity's global
permission rather than by a tenant permission, which is what the guards check:
without `hasGlobalPermission`, a call that addresses a null tenant is refused,
and with it the call may address tenanted and unowned rows alike. See
"Reads" below and `docs/permissions.md`.

## Reads: `@queryFilter required`

Marking `tenantId` a required filter makes every read of the entity name it, so a
read cannot list another tenant's rows by omitting a filter. The requirement is
enforced in four places, from the type down to the resolver — see
`docs/queries.md`. `Tenant`, `Locale`, and `LogEntry` have no `tenantId` and so
nothing to require; a read of them is unscoped.

On an optional owner the filter value may also be a null test: a nullable column
takes one, so `filter: { tenantId: { isNull: true } }` reads the rows that belong
to no tenant and `{ isNotNull: true }` reads every tenanted row. A null test
names no tenant, so the guard refuses it without the global permission; naming
tenants instead checks `hasTenantPermission` for each.

That alone is not enough: it scopes what is *read*, not what is *written*.

## Links: `@foreignKey <Entity> scope=<column>`

A foreign key names one column, so `@foreignKey Widget` on `widgetId` says the
row points at a widget and says nothing about the tenant. Writes go through the
generated repositories, but nothing stops `tenantId` and `widgetId` from
disagreeing, which would produce a row that one tenant can read and no tenant
owns.

`scope=<column>` makes the reference **composite**: the pair must exist on the
target, and the column it names is the one the target declares with
`@tenantOwned`.

```ts
/**
 * @fieldName Widget
 * @foreignKey Widget scope=tenantId
 * @widget text
 */
widgetId: WidgetId;
```

```sql
constraint "widget_row_tenantId_widgetId_fkey"
    foreign key ("tenantId", "widgetId") references "widget" ("tenantId", "id")
```

The referencing interface declares a column of that name too — its own owned
column, so a child links to a parent inside one tenant or not at all. The
generator covers the pair with the unique constraint a composite reference needs
(`constraint "widget_tenantId_id_key" unique ("tenantId", "id")`). Nothing else
changes: the repository generators write the same columns, and a `@relation`
still joins through the target's key, because the key alone identifies the row.

This is a **database** constraint rather than a check in generated SQL, so it
holds for every writer — the repositories, a batch, a migration, `psql`. It also
guards the other direction: moving a parent's tenant out from under a child is
refused. And it composes: `widget_snapshot_row` is scoped to `widget_snapshot`,
which is scoped to `widget`, so the chain holds two levels deep without a third
rule.

In the example, five relations carry a scope: `WidgetRow` → `Widget`,
`WidgetSnapshotRow` → `WidgetSnapshot`, `WidgetSnapshot` → `Widget`, `Widget` →
`Account`, and `Widget` → `Supplier`. The `tenantId` keys into `Tenant` are not
scoped: `Tenant` is the root, so there is no second column to agree with.

An optional owner takes no part in a composite reference. `MATCH SIMPLE` matches
nothing when any column of the pair is null, so a scope column on an optional
owner would silently switch the check off; the linter already requires every
scope column to be required. For the same reason an optional owner cannot be the
*target* of a scope: a global parent has no tenant to match. A reference to an
optionally owned interface is therefore unscoped and checks existence only, and
an optional owner cannot reference a required owner at all: a global row has no
tenant to agree on.

## What is written and what is checked

The column is the one thing `@tenantOwned` derives: it defaults to the
interface's single link to the root, and a bare tag where that link is missing or
repeated is a finding, so the derivation never guesses.

Everything else is **written and checked rather than defaulted**. A reference
that omits `scope=<column>` generates an unscoped constraint — the single-column
link the annotation exists to prevent — so the omission is reported by the
linter, and because it runs before the generators (`docs/tasks.md`), a spec that
forgets one writes no artifact at all. `pnpm run generate` and `pnpm run check`
both go through it; a standalone `pnpm generate:<artifact>` runs the generator
alone, as it does for every other annotation.

The `optional` word works the same way: it is checked against the field, not
inferred from it. A nullable tenant column without the word is a finding, and so
is the word on a required field, so a reader never has to guess whether a null
tenant is intended.

## Rules

- The scope field is **required**. `MATCH SIMPLE`, the Postgres default for a
  composite key, matches nothing when any column of the pair is null, so a
  nullable scope would silently switch the check off. The linter reports it.
- The scope field **may not be the referencing field itself**, which lints
  cleanly but cannot be satisfied.
- The target must declare a field of the same name, so the pair can be matched.
  The linter checks the referencing interface; the table model checks the target,
  since that needs the other interface's fields (`docs/spec-annotations.md`).
- The scope is **written at the reference** and checked against the target's
  `@tenantOwned`: the same fact in two places, so a reader sees it where the
  reference is, and the linter reports either half left out or disagreeing.
- `onDelete=setNull` **may not** accompany a scope. Postgres nulls every column of
  a composite key on delete, and the scope is required, so the delete could never
  succeed. A partial `set null (column)` list is not generated.
- The referencing column may still be optional. A null `accountId` means "no
  account", and the pair is not matched — which is the intent, not a gap.
- An optional owner **may not be a scope's source or target**. A nullable scope
  matches nothing, and a global parent has no tenant to match, so either side
  makes the constraint silently vacuous. A reference to an optional owner is
  unscoped, and an optional owner cannot reference a required owner.

## What this does not cover

- **A scope that is not a key lookup.** `widget_snapshot."accountId"` carries no
  foreign key at all: the account is copied into the row as a snapshot, so there
  is no reference to constrain.
- **An interface that is meant to be tenanted but says nothing.** `Locale` and
  `LogEntry` are global because they carry neither `@tenantOwned` nor a
  `tenantId`, and nothing tells that apart from an entity whose tenancy someone
  forgot. Intent is checkable once one of the two is written.
- **A reference to an optional owner is one-directional.** The unscoped foreign
  key proves the row exists, not that a tenanted child points at a parent in its
  own tenant; there is no second column to compare while the parent may be
  global.
- **Authorization inside the SQL.** The generated routes guard every call: a
  global permission allows it, otherwise the guard resolves the tenants the
  argument names and requires a permission in each (`docs/permissions.md`).
  Nothing scopes the statement itself: a resolver that ignored the filter would
  still read across tenants. Postgres RLS with a per-request executor is the
  database-level mechanism, and it is not implemented — see `docs/rest-api.md`.
