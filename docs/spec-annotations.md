# Spec annotations

Field-level JSDoc tags in `packages/spec/` are the machine-readable contract a generator
consumes. This note records what each tag means and how it lands in Postgres.

## Naming

Two rules decide every tag name, and both are checkable by eye.

**A multi-word tag is camelCase.** `@fieldName`, `@createdAt`, `@updatedAt`,
`@primaryKey`, `@foreignKey`, `@queryFilter`, `@queryOrderBy`, `@queryWhere`. A
one-word tag is lowercase: `@widget`, `@computed`, `@unique`, `@version`,
`@relation`, `@children`, `@inlined`, `@primitive`, `@zod`.

**A Postgres-specific tag carries the `pg` prefix.** `@pgType`, `@pgTable`,
`@pgDefault`, `@pgVirtual`, `@pgTrigger`. The prefix and the word
are both visible, so `pg` marks the dialect and the capital marks the word: a
portable SQL concept stays unprefixed (`@primaryKey`, `@foreignKey`, `@unique`),
and a tag that only a query read consumes carries `query` instead (`@queryFilter`,
`@queryOrderBy`, `@queryWhere`). See "Why the expressions live in the spec".

## Tags

Field tags:

- `@fieldName` — human-readable label. Presentation only.
- `@widget` — suggested UI control (`text`, `number`, `date`, `select`, `table`, `textarea`). Presentation only.
- `@computed` — derived rather than client-supplied. A bare marker: how Postgres
  materializes it is a separate mechanism tag, one of `@pgVirtual` or
  `@pgTrigger`. A nullable one is omitted from
  `<name>InsertSchema`, since the row that fills it arrives later; a required one
  has no default and must be supplied. See `docs/validation.md` and
  "`@computed` mechanisms".
- `@pgVirtual <expression>` — the field is a Postgres `generated always as (…)
  virtual` column, with the expression written verbatim. It may reference only
  regular columns of its own table: not other generated columns, not other
  tables, and only immutable functions. Postgres owns the column outright, so a
  create never writes it and the generator keeps it out of the insert and patch
  paths.
- `@pgTrigger <statement>` — the field is assigned by a `before insert or
  update` trigger on its own table. The statement is written verbatim with
  `NEW.` and is emitted in interface field order, beside the table's clock
  assignment.
- `@pgTrigger <header>: <statement>` — the same tag with a header moves the
  trigger to another table and shapes it the way `CREATE TRIGGER` does. The
  header is the timing, then the events, then the table: `after insert or update
  or delete on InvoiceRow:`. The statement is written verbatim, and it must be
  correct for every event the header names: `NEW.` on insert and update, `OLD.`
  on delete. See "`@pgTrigger` headers" below.
- `@createdAt` — the row's creation moment. A bare marker on a `Date` field: the
  column becomes `not null default now()`, and no create or patch writes it. See
  `docs/timestamps.md`.
- `@updatedAt` — the row's last-write moment. A bare marker on a `Date` field: the
  column becomes `not null default now()`, and every write assigns
  `NEW."<field>" := now()` in the table's trigger. See `docs/timestamps.md`.
- `@pgDefault <expression>` — a database column default, written verbatim into the DDL. The field may be optional, and a create may omit it; the SQL then writes `default` in place of the value, so the database fills it. `<name>InsertSchema` accepts the field whether or not it is supplied, and a patch may set it like any other column. May accompany `@computed`: the default covers the insert path, the trigger every write, and the two agree on insert. A `@version` field is the exception: a defaulted version stays out of a create, since its default is the first revision. See `docs/repositories.md`.
- `@primaryKey` — a column of the table's primary key. A bare marker on a scalar
  field: the column is `not null`, and the generated reads filter on it by
  default. One field is a single-column key; marking several makes a composite
  key, whose column order is the declaration order. Every interface declares at
  least one. See "`@primaryKey` and `@foreignKey`" below.
- `@foreignKey <Entity>` — the field is the column pointing at `<Entity>`'s
  primary key. The value names the interface; the column type and the referenced
  column come from that table, not from the field's own type. See "`@primaryKey`
  and `@foreignKey`" below.
- `@relation` — the field holds a single related entity. A bare marker that adds no column: it navigates through the field carrying `@foreignKey <entity>`. The entity is the field type, which must be an interface. See `@relation` below.
- `@children` — the field holds a child collection (`<Entity>[]`). Not a column; the child table carries the foreign key. A bare marker; the element type must be an interface.
- `@inlined` — the field holds an entity whose scalar fields are flattened, prefixed with the field name, into snapshot columns on the same table. No foreign key. A bare marker; the field type must be an interface.
- `@unique` — the column is unique.
- `@version` — the optimistic-lock column. Omitted on insert (the `@pgDefault`
  supplies the first revision) and written on update as the caller's
  precondition; a `before update` trigger validates and increments it. At most
  one per interface, the field type must be `Version`, and it is exclusive with
  `@computed`. See `docs/versioning.md`.
- `@queryFilter` — a bare marker that makes the field a filter of the entity's
  generated reads. A filter is a set matched with `in (…)`; several are combined
  with `and`. Scalar fields only; a branch field may not carry it, and it is
  redundant on the `@primaryKey` field, which is a filter by default. See `docs/queries.md`.
- `@queryOrderBy` — makes the field an ordering key of the entity's generated
  reads. A bare marker whitelists the field; `@queryOrderBy default asc|desc`
  also makes it the entity's default ordering (at most one per interface).
  Scalar fields only; a branch field may not carry it. See `docs/queries.md`.
- `@queryWhere <op>…` — whitelists the comparison operators the field may be narrowed
  with, space-separated, one or more of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`.
  The list is required: a bare `@queryWhere` is a lint finding. Scalar fields only; a
  branch field may not carry it. See `docs/queries.md`.

Interface tags:

- `@pgTable <name>` — the Postgres table name. Defaults to the snake_cased interface name.
- `@pgTrigger <statement>` or `@pgTrigger <header>: <statement>` — a trigger that runs
  for the table rather than for one field, so it may not assign a column (there is
  no field to claim) and may not carry `on` (it is already attached). The header
  is the same grammar as the field tag's, and the level defaults to
  `for each statement` — Postgres' own default, and the only level at which
  `NEW` and `OLD` are unavailable. Write `for each row` to log or check one row at
  a time. See "Where a trigger is declared" below.

Type tags:

- `@primitive` — a bare marker on a type alias that identifies it as a scalar
  value type rather than an entity. Applied to the aliases in
  `packages/spec/src/primitives/`. A `@primitive` type must carry a matching
  `@zod` and `@pgType`; the marker itself takes no value. See `docs/primitives.md`.
- `@zod <expression>` — the type's Zod schema, written verbatim and never
  evaluated by the spec, such as `z.uuid()` or
  `z.uuid().brand<"Something">()`. It is what gives a primitive a runtime
  counterpart to its compile-time brand. At most one per type alias.
- `@pgType <sql-type>` — the storage type a generator maps the alias to, such as
  `uuid` or `decimal`. The spec declares *what* the value is stored as; a
  generator reads the tag rather than knowing the domain type by name, so adding
  a primitive does not require editing the backend. `@primitive` types must
  carry it. See `docs/primitives.md`.

Type tags sit on a type alias and are validated as a group: `@primitive` types
must declare `@zod` and `@pgType`, and any tag outside the three is reported. A
field never carries a type tag; an alias never carries a field or interface tag.

`@relation`, `@children`, and `@inlined` are bare markers: they take no value.
The entity and the cardinality both come from the field
type, so `owner?: Owner` with `@relation` links to `Owner`, and `rows?: Row[]`
with `@children` makes `Row` the child. This removes a second source of truth
that could disagree with the type — a tag naming an entity other than the
field's is not expressible. `@foreignKey` is the exception: a key column's type
may be an opaque alias, so the tag names its target. `@relation` and `@inlined`
must be on a single entity, `@children` on an array of one, and the three are
mutually exclusive.

`@computed` says the database derives a value, not that a client supplies one.
How the value arrives is the mechanism tag beside it: a generated column or a
trigger. Everything else is an ordinary field — a key the
application assigns, a column with a `@pgDefault` — and no tag marks it. The clock
tags cover the two timestamp spellings; see `docs/timestamps.md`.

## `@primaryKey` and `@foreignKey`

The key tags say what a column *is*, without deriving it from a name or a type:
`@primaryKey` marks the table's key, and `@foreignKey <Entity>` marks a column
that points at another table's key. Neither convention survives — a field named
`id` is not a key unless it is tagged, and an `<Entity>Id` type is not a foreign
key unless it is tagged. Every entity declares at least one `@primaryKey`, and a
missing one is a generation error rather than a fallback. Marking several fields
builds a composite key, whose column order is the order the fields are declared:

```ts
/**
 * @fieldName ID
 * @primaryKey
 * @widget text
 */
id: InvoiceId;

/**
 * @fieldName Customer ID
 * @foreignKey Customer
 * @widget text
 */
customerId?: CustomerId;
```

```ts
/**
 * @fieldName Language code
 * @primaryKey
 * @widget text
 */
lang: string;

/**
 * @fieldName Key
 * @primaryKey
 * @widget text
 */
key: string;
```

`@foreignKey Customer` takes the column's storage type and referenced column
from `Customer`'s own `@primaryKey` field, so the field's declared type is
documentation and may be an alias this model cannot resolve. Both tags sit on a
single scalar field and are mutually exclusive, so a self-referencing key is not
expressible; that keeps the pair unambiguous. A `@foreignKey` names one column,
so pointing at an entity whose key is composite is a diagnostic rather than a
partial reference.

## `@relation`

A `@relation` field is *navigation*: it names the entity on the other side of a
foreign key. The key itself is an ordinary field the interface declares, carrying
`@foreignKey <entity>`:

```ts
/**
 * @fieldName Customer
 * @relation
 * @widget select
 */
customer?: Customer;

/**
 * @fieldName Customer ID
 * @foreignKey Customer
 * @widget text
 */
customerId?: CustomerId;
```

The alternative — the tag synthesizing the column — would put one fact in two
places: the tag's entity and the key field's type could disagree. Here the
generator joins the two fields by the table the key points at, and a mismatch is
a diagnostic rather than a silent second column. Either half alone is also a
diagnostic: a `@relation` with no `@foreignKey` field referencing its table, or
an ambiguous pair of keys into the same table.

Nullability lives on the `@foreignKey` field, so a required relation needs a
required key; the relation field's own optionality does not matter to the DDL.
The key is a normal scalar field: it is selectable, and it takes `@queryFilter`
like any other, which is how a read filters by a relation. The `@relation` field
itself may not carry `@queryFilter`; filtering on the related record's *columns*
is not implemented.

## `@inlined`

```
@inlined
```

An `@inlined` field is an entity reference that is *copied* rather than
*linked*. Instead of a `<field>Id uuid references …` column, the target entity's
scalar fields are flattened into columns on the same table, prefixed with the
field name:

| `Customer` field | `InvoiceSent.customer` column |
| --- | --- |
| `id` | `customerId` |
| `name` | `customerName` |
| `email` | `customerEmail` |

No foreign key is emitted, so the row survives a change to — or the deletion of —
the referenced entity. That is the point: an inlined entity is a snapshot of the
values at write time, not a live link. `@inlined` and `@relation` are mutually
exclusive; `@inlined` is the snapshot spelling, `@relation` the linked one.

Nullability propagates: a column is `not null` only when both the outer field and
the inlined field are required, so an optional `customer?: Customer` yields all
nullable customer columns.

The inlined columns carry the target field's type (including a closed-union
CHECK) but not its `@unique`. `@computed` on the target is
ignored: an inlined value is data, not a derivation. Non-scalar target fields
(entity references or child arrays) are a diagnostic; `@inlined` flattens scalars
only.

## `@computed` mechanisms

`@computed` is a bare marker meaning "derived"; exactly one mechanism tag says
how Postgres materializes it, and the expression is written on the field:

```
/**
 * @fieldName Net amount
 * @widget number
 * @computed
 * @pgTrigger NEW."netAmount" := round(NEW."quantity" * NEW."unitPrice", 2)
 */
```

Three mechanisms, chosen by what the expression needs:

- `@pgVirtual` — a `generated always as (…) virtual` column. Cheapest to
  maintain and impossible to leave stale, but constrained: same-row columns
  only, immutable functions only, no referencing another generated column, and
  no index on the result.
- `@pgTrigger` — a row-level trigger. Freer than a generated column (it may read
  other columns the trigger assigned earlier in the same pass) and indexable, and
  the only mechanism that can read another table, by naming it in the header.
  The same tag on an interface declares a trigger with no column behind it.

`invoice.totalAmount` is the one `@pgVirtual` field: it is a same-row sum of two
regular columns. `invoice.netAmount`/`taxAmount` are `@pgTrigger` on
`invoice_row` because a sum over that table cannot be a generated column. The
`invoice_row` amounts are `@pgTrigger` on their own table because `taxAmount`
reads `netAmount` and `totalAmount` reads both, and a generated column cannot
reference another generated column.

## Why the row amounts are trigger assignments

The chain is `netAmount`, then `taxAmount`, then `totalAmount`. Two properties of
generated columns forbid expressing it directly:

- A generated column's expression may not reference another generated column.
- A `before` trigger sees `NEW."<generated column>"` as null, so the later
  assignments could not read `netAmount` even if it were virtual.

Making the row amounts virtual would mean inlining `round(NEW."quantity" *
NEW."unitPrice", 2)` into all three expressions. The trigger keeps one
expression per amount and preserves the order, and `@pgTrigger` makes that
choice explicit in the spec.

## Why the aggregate amounts are written

An invoice is a legal document, so an issued amount should not change when
rounding or tax rules change. A trigger writes the aggregated value once, when a
child row changes, and the column keeps it. `@pgVirtual` is used only where the
value is a pure function of two columns on the same row, so a recomputation from
those columns always reproduces the same figure.

## `@pgTrigger` headers

A header is the timing, the events, the optional table, and the optional level,
then a colon and the statement. It mirrors `CREATE TRIGGER`:

```
@pgTrigger after insert or update or delete on InvoiceRow: update "invoice" set "netAmount" = (select coalesce(sum("netAmount"), 0) from "invoice_row" where "invoiceId" = "invoice"."id") where "id" in (OLD."invoiceId", NEW."invoiceId")
```

- The timing is `before` or `after`. Without a header the timing is `before` and
  the events are `insert` and `update`. With a header the field's own table is
  still the default when `on` is left out.
- The events are `insert`, `update`, and `delete`, joined by `or`, and at least
  one is required. The statement runs for every event listed, so it must be
  correct for all of them: `NEW` is null on delete and `OLD` is null on insert.
  The statement above covers both with `in (OLD."invoiceId", NEW."invoiceId")`,
  which recomputes the invoice the row left as well as the one it joined.
- `on <Entity>` attaches the trigger to that entity's table instead of the
  field's. The named table must carry a `@foreignKey` into the field's own
  table, because the trigger writes the parent back; generation fails otherwise.
  A statement that reads a *second* table referencing the parent is also an
  error, since that table's writes would leave the field stale — write a second
  `@pgTrigger` for it.
- `for each row` or `for each statement` names the level, in Postgres' own
  words. Unstated, a field-level trigger is `for each row` and an
  interface-level one is `for each statement`.
- The statement is written verbatim, as a `@pgVirtual` expression is. It names
  its own tables and columns, so it can be read, corrected, and run without
  substituting anything, and `grep "invoice_row"` finds it.
- `instead of` is not accepted: it needs a row-level trigger on a view, and the
  spec has no view entity to attach one to.

Every trigger on one table with the same timing, events, and level shares one
function, so several fields' statements are emitted together in interface field
order, and the interface's own statements after them. That order is
load-bearing: on `invoice_row` each assignment reads the one before it, and an
interface-level statement runs last so it can read a derived value rather than
the value the client sent. `@updatedAt` joins the same `before insert or update`
function in field order.

## Where a trigger is declared

The owner of a trigger is the thing that declares it, which is why placement is a
rule rather than a preference:

| declared on | `@computed` | `NEW."<col>" :=` | level | for |
| --- | --- | --- | --- | --- |
| a field | required | the only way to fill it | always `for each row` | a derived column |
| the interface | n/a | rejected | `for each statement`, or `for each row` as written | a write with no column: an audit row, an invariant |

`@computed` on the field is what keeps a column out of the insert and patch
paths, so a statement that assigns a column has to sit on that field, next to the
claim it makes. A statement that assigns nothing has no field to sit on, and a
statement-level trigger *cannot* assign: `NEW` and `OLD` are null there, so
reading either is a runtime error rather than a compiled one. Hence the two
rules above — a field-level trigger may not be statement-level, and an
interface-level trigger may not assign.

An interface-level trigger is also where `REFERENCING` transition tables would
live, since Postgres allows them only on an `after` statement-level trigger on a
plain table. Nothing generates them yet; see "Deliberately not implemented".

## Column naming

Columns are named exactly as the TypeScript fields, quoted camelCase
(`"unitPrice"`, `"netAmount"`). There is no field-to-column mapping, so the tags
and the spec fields use identical identifiers. Changing a field name therefore
changes a column name — intentional, since it keeps one name in play.

## Number representation

Every numeric column is `decimal`, from the `Decimal` brand, which the drivers
return as a string. Rounding is therefore part of the expression rather than a
column type:

- `rowNetAmount` is `round(NEW."quantity" * NEW."unitPrice", 2)`, fixing money to
  two decimals.
- `rowTaxAmount` is `round(NEW."netAmount" * NEW."taxRate", 2)`, where `taxRate`
  is a fraction (`0.255` is 25.5%).
- The aggregates need no cast, since `sum` of `decimal` is `decimal`.

Rationale is in `docs/primitives.md`.

## Gotchas

- **An aggregate cannot be `@pgVirtual`.** Postgres forbids a generated column
  from referencing another table, so `Invoice.netAmount` (a sum over
  `invoice_row`) must be a `@pgTrigger` whose header names `on InvoiceRow`.
- **A generated column cannot read another generated column,** and a `before`
  trigger cannot read one either — `NEW."<col>"` is null for a virtual column.
  The `invoice_row` amounts stay `@pgTrigger` for this reason.
- **Trigger order is part of the contract.** For `invoice_row`: `netAmount`,
  then `taxAmount`, then `totalAmount`. Reordering the fields produces stale
  values rather than an error.
- **A cross-table trigger names its table in the header.** The tag names one
  table, and the statement names its tables and columns verbatim, so a rename of
  the child's foreign key field breaks the statement — as it breaks a same-row
  `@pgTrigger` expression, and for the same reason: column names are field names.
- **The invoice total is not set by the `invoice_row` trigger.** It writes
  `netAmount` and `taxAmount` only; `totalAmount` is virtual, so it recomputes on
  read. No ordering is load-bearing there, which is the point of choosing
  `@pgVirtual`.
- **Currency is not yet modelled.** `Invoice.currency` was removed, so amounts
  currently carry no currency. The doc comments that say "in the invoice
  currency" are forward references to work not yet done.
- **Tags must be on their own line.** A tag written inline on the same line as
  the field, as in `/** @unique */ code: string;`, is not attached to the field
  and is silently ignored by both the generator and the linter. Use a JSDoc block.
- **No tag is a valid state.** An ordinary field carries neither `@computed` nor
  a mechanism tag. Only present tags are validated.
- **Virtual columns are indexable only by expression.** Postgres rejects a plain
  index on a virtual column, so a query that would index one needs the
  expression index spelled out or the `@pgTrigger` mechanism instead.

## Deliberately not implemented

- **Views for a read-time projection.** A derived view would recompute on every
  read; the mechanisms above cover what the spec needs today, and nothing emits
  a view.
- **Transition tables.** `REFERENCING OLD TABLE`/`NEW TABLE` would give an
  interface-level `after` statement-level trigger the whole set of affected rows
  at once. The grammar has a place for it — the header already reads like
  `CREATE TRIGGER` — but nothing parses the clause, because no rule needs the
  row set yet.
- **A cross-table `@pgVirtual`.** Postgres rejects it outright, so no generator
  support is planned.
- **Multi-currency rows.** Rows may eventually be issued in currencies other
  than the invoice's, which needs an exchange rate per row and a converted total
  in the invoice currency. The `@pgTrigger` expressions would gain
  rate-aware arithmetic, and the rounding/tax ordering (convert-then-tax vs
  tax-then-convert) would need to be pinned down.
- **Rate dates.** Invoices normally lock an exchange rate as of a specific date,
  which is frequently not `issueDate`.

## Wiring

1. A generator parses the `@` tags from `packages/spec/`.
2. For each `@computed` field it reads the mechanism tag off the field itself:
   `@pgVirtual` becomes a generated column, and `@pgTrigger` a row-level
   trigger — a `before insert or update` assignment on its own table by default,
   or the timing, events, table, and level its header names. A `@pgTrigger` on
   the interface itself adds a statement-level trigger to the same pass.
3. `@createdAt` becomes a `default now()`, and `@updatedAt` that plus a trigger
   assignment.

`packages/backend/scripts/generate-postgres-schema.ts` implements all of the
above. See `docs/schema-generation.md`.

## Why the expressions live in the spec

The `@pg*` tags are deliberately Postgres-specific: `packages/spec/` names the
storage the backend uses rather than describing a second, abstract vocabulary
that only one backend consumes. The prefix marks a tag whose concept or spelling
is Postgres-specific — `@pgType` a storage type name, `@pgVirtual` and
`@pgTrigger` the expressions that materialize a derivation,
`@pgDefault` a column default, and `@pgTable` the table name itself. A portable
SQL concept stays unprefixed: `@primaryKey`, `@foreignKey`, `@unique`, and the
two clock tags.

The `query` prefix marks the other kind of consumer-only tag: `@queryFilter`,
`@queryOrderBy`, and `@queryWhere` describe a generated read rather than a
column. They emit no DDL, so a reader scanning for storage can skip them, and a
tag that is neither storage nor query carries no prefix at all.

The same convention reaches the parsed model, so a consumer can tell a Postgres
value from a neutral one by the field it reads: `SpecInterface.pgTableName` is
the resolved table name and `Tags.pgDefault` the default expression, while
`SpecInterface.name`, `SpecProperty.typeText`, and `Tags.primaryKey` stay
unprefixed. Only the tag keys and the model fields that hold a Postgres value
are prefixed; a resolved value inside `postgres-model.ts`, such as
`Column.sqlType`, is not, because that module is Postgres-only by name.

That means a different backend needs its own tags, exactly as it needs its own
`@pgType` mapping. There is no name indirection to resolve and no registry to
keep in step, so a field's expression sits next to the field it describes:

```
/**
 * @fieldName Total amount
 * @computed
 * @pgVirtual "netAmount" + "taxAmount"
 * @widget number
 */
totalAmount?: Money;
```

## Linting

`pnpm lint:spec` runs `packages/spec/scripts/lint-spec.ts`, which walks the
interfaces in `packages/spec/` with ts-morph. Run it whenever a tag changes.

Enforced:

- Tags are limited to the field and interface tags listed above.
- Retired tags (`@generated`, `@default`, `@table`, `@readonly`, `@type`,
  `@values`, `@formula`) report their replacement.
- `@fieldName` and `@widget` are required; `@widget` must be a known widget.
- `@computed` takes no parameters; the expression sits in the mechanism tag
  beside it.
- A mechanism tag (`@pgVirtual`, `@pgTrigger`) requires `@computed`, and at most
  one may appear on a field. Both carry a non-empty expression or statement. The
  requirement is per placement: a field-level `@pgTrigger` needs `@computed`
  because it fills that field, while an interface-level one takes no `@computed`
  at all, since there is no field to compute.
- `@pgTrigger` names `before` or `after`, then `insert`, `update`, `delete`, or
  `or`, optionally `on <Entity>`, optionally `for each row|statement`, then `:`,
  then the statement. At least one event is required, an unknown event or level
  is reported, and `instead of` is rejected because it is a trigger on a view.
  The linter does not resolve the entity — the generator does, against the whole
  spec.
- A field-level `@pgTrigger` may not be `for each statement`, since a
  statement-level trigger cannot assign its column. An interface-level one may
  not assign a column and may not carry `on`, since it is already attached to its
  own table.
- `@createdAt` and `@updatedAt` take no value, sit on a `Date` field, are
  mutually exclusive with each other and with `@computed`,
  `@pgDefault`, `@version`, and the mechanism tags, and may appear at most once per
  interface.
- `@inlined` requires an entity name and is mutually exclusive with `@relation`
  and `@children`.
- `@primaryKey` is a bare marker on a scalar field, and may appear on several
  fields of one interface to form a composite key; `@foreignKey` requires the
  interface it references and sits on a single scalar field. The two are
  mutually exclusive. See "`@primaryKey` and `@foreignKey`".
- `@queryFilter` is a bare marker on a scalar field; a branch field may not
  carry it, and it must not be written on the `@primaryKey` field, which is a
  filter already. See `docs/queries.md`.
- `@queryOrderBy` is a bare marker on a scalar field, or `default asc|desc`; a
  branch field may not carry it, and at most one field may declare the default.
  See `docs/queries.md`.
- `@queryWhere` requires at least one operator, each one of `eq`, `ne`, `gt`, `gte`,
  `lt`, `lte`; a branch field may not carry it. See `docs/queries.md`.
- Tags may not repeat on a field.

Gotchas:

- **`@computed` takes no parameters.** It is a bare marker; the expression sits
  in the mechanism tag beside it, so `storage=` or `formula=` on it is a finding.
- **`@formula` is not a recognised tag.** A type alias carrying it reports "not a
  recognised type tag", and a field carrying it reports the mechanism tags that
  replace it. It is in the retired-tag table above.
- **Absence of a mechanism tag is valid.** A `@computed` field with no `@pg*`
  tag is accepted and the generator emits nothing for it. That is the escape
  hatch for a derivation that is not yet implemented, and it is why the linter
  does not require a mechanism.
- **Node 24 runs the script directly.** `node scripts/lint-spec.ts` relies on
  native type stripping; there is no build step and no `tsx`.
- **Statically decidable only.** The linter checks the tags, not whether an
  expression is semantically right for its field, nor whether the SQL is
  syntactically valid. `pnpm test` executes the generated `schema.sql` in PGlite,
  which is what catches a malformed expression.
- **Every primary key column is a filter without a tag.** `spec-model.ts` marks
  each `@primaryKey` field as `queryfilter` when it parses an entity, so a
  composite key contributes one filter per column. Writing `@queryFilter` on a
  key field is therefore a lint finding, not a second way to say the same thing:
  the default has one spelling.
- **`@queryFilter` is checked structurally, not by type.** The linter rejects it
  on a branch field (a `@relation`/`@children`/`@inlined` marker), on the
  primary key, and on a value, but it does not resolve the field's type: the
  generated read types the filter from the field's own type, so a non-scalar
  would surface there.
- **`@relation` and its `@foreignKey` field are paired by the generator, not the
  linter.** The linter checks tags; the cross-field rule is enforced when the
  table model is built, so the diagnostic comes from `pnpm generate` with a file
  and line, the same way `@children` without a foreign key does. See
  `docs/schema-generation.md`.
