# Examples

The notes under `docs/` describe mechanisms, not one application. Every example
therefore uses an invented vocabulary, so a note outlives a change to the demo
spec: a rename, a dropped entity, or a new field never reaches these pages.

The invented names are placeholders. `Widget` is any entity, `WidgetRow` its
`@children`, `WidgetSnapshot` a snapshot of it, `Account` whatever it points at.
Read them as "an entity", "its children", and so on — the surrounding rule is
the content, the names are scaffolding.

## The vocabulary

| Name | Stands for |
| --- | --- |
| `Widget` | an entity: the one a note is usually about |
| `WidgetId` | its branded primary key |
| `WidgetRow` | a `@children` entity, one row per parent |
| `WidgetSnapshot`, `WidgetSnapshotRow` | a snapshot entity and its rows: copied at write time, not referenced |
| `WidgetTag` | an entity whose key is composite |
| `Account` | an entity a `Widget` points at with `@foreignKey` |
| `Supplier` | a second referenced entity, where one note needs two |
| `Locale`, `LogEntry` | entities that carry no tenant, in the tenancy note |
| `Message` | an entity used only as a write target, in the validation note |

The names follow the shape a generated artifact takes, so an example reads like
real output:

- **Type and key.** `Widget` is singular PascalCase; `WidgetId` brands its
  **key**, and a child is `<Parent>Row`.
- **Table.** `widget`, `widget_row`, `widget_snapshot`, `widget_snapshot_row` —
  the type name snake_cased, singular.
- **Column.** camelCase, matching the field: `widgetId`, `accountId`,
  `subtotal`, `startsAt`.
- **Repository.** `<verb><Entity>`: `createWidget`, `upsertWidget`,
  `updateWidget`, `deleteWidget`.
- **Read.** `query<Entity>`: `queryWidget`, `queryWidgetRow`.
- **Schema and write type.** `widgetInsertSchema` and `WidgetInsert`, then
  `Upsert`, `Patch`, and `PrimaryKey` the same way.
- **Operation.** `<verb><Entity>`, its contract `<Entity>Operations`, its input
  `SendWidgetInput`, its route `POST /widget/send`, and its declared error
  `WidgetDetailsError`.

A field name is invented for the same reason: `code`, `subtotal`, `surcharge`,
`total`, `startsAt`, `endsAt`, `frozenAt`, `notes`. None of them is a claim
about what the demo spec declares.

## What is not an example

Two kinds of name stay as they are, because they name a mechanism rather than a
domain:

- **Tag names.** `@entity`, `@primaryKey`, `@foreignKey`, `@version`,
  `@createdAt`, `@updatedAt`, `@tenantOwned`, and the rest are the contract
  itself. `docs/spec-annotations.md` is their reference.
- **The tenancy root.** The notes spell it `Tenant` with a `tenantId`, because
  the tags are `@tenant` and `@tenantOwned`; the column a scoped entity matches
  on is `tenantId` whatever the spec calls its root.

A real path is written as it is, too. When a note points at
`scripts/backend/generate-repositories.ts`, it means that file; only
the entities and fields inside an example are placeholders.
