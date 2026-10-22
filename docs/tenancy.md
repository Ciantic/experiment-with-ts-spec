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
 * @tenantOwned tenantId
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
```

## The root: `@tenant`

`@tenant` is a bare marker on the interface that owns the graph, and the linter
reports a second one: one root keeps every scope unambiguous. The root is never
`@tenantOwned`, since there is no higher scope for it to agree with, and a
reference to it is never scoped.

`Tenant` is the only interface in the example that carries the tag.

## Ownership: `@tenantOwned <column>`

`@tenantOwned` names the column that scopes the interface. The linter requires
that field to exist, to be required, to be a scalar column rather than a branch,
and to link to the root with `@foreignKey Tenant`: the link is what makes the
column a tenant column rather than a bare id. An interface that declares neither
the tag nor a `tenantId` is global, which is what `Locale` and `LogEntry` are.

## Reads: `@queryFilter required`

Marking `tenantId` a required filter makes every read of the entity name it, so a
read cannot list another tenant's rows by omitting a filter. The requirement is
enforced in four places, from the type down to the resolver — see
`docs/queries.md`. `Tenant`, `Locale`, and `LogEntry` have no `tenantId` and so
nothing to require; a read of them is unscoped.

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

## The tags are the only source

Nothing fills a tag in. A reference that omits `scope=<column>` generates an
unscoped constraint — the single-column link the annotation exists to prevent —
so the omission is **checked rather than defaulted**: the linter reports it, and
because it runs before the generators (`docs/tasks.md`), a spec that forgets one
writes no artifact at all. `pnpm run generate` and `pnpm run check` both go
through it; a standalone `pnpm generate:<artifact>` runs the generator alone, as
it does for every other annotation.

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

## What this does not cover

- **A scope that is not a key lookup.** `widget_snapshot."accountId"` carries no
  foreign key at all: the account is copied into the row as a snapshot, so there
  is no reference to constrain.
- **An interface that is meant to be tenanted but says nothing.** `Locale` and
  `LogEntry` are global because they carry neither `@tenantOwned` nor a
  `tenantId`, and nothing tells that apart from an entity whose tenancy someone
  forgot. Intent is checkable once one of the two is written.
- **Authorization.** Nothing reads a principal. A constraint stops two tenants
  from being linked; it does not stop a caller from naming one tenant and reading
  another's rows in a filter. Postgres RLS with a per-request executor is the
  mechanism for that, and it is not implemented — see `docs/rest-api.md`.
