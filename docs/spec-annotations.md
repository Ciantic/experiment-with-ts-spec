# Spec annotations

Field-level JSDoc tags in `packages/spec/` are the machine-readable contract a generator
consumes. This note records what each tag means and how it lands in Postgres.

## Tags

Field tags:

- `@fieldName` — human-readable label. Presentation only.
- `@widget` — suggested UI control (`text`, `number`, `date`, `select`, `table`, `textarea`). Presentation only.
- `@computed` — derived rather than client-supplied. A bare marker: how Postgres
  materializes it is a separate mechanism tag, exactly one of `@pgvirtual`,
  `@pgtrigger`, or `@pgrollup`. A nullable one is omitted from
  `<name>InsertSchema`, since the row that fills it arrives later; a required one
  has no default and must be supplied. See `docs/validation.md` and
  "`@computed` mechanisms".
- `@pgvirtual <expression>` — the field is a Postgres `generated always as (…)
  virtual` column, with the expression written verbatim. It may reference only
  regular columns of its own table: not other generated columns, not other
  tables, and only immutable functions. Postgres owns the column outright, so a
  create never writes it and the generator keeps it out of the insert and patch
  paths.
- `@pgtrigger <statement>` — the field is assigned by the table's `before insert
  or update` trigger. The statement is written verbatim with `NEW.` and is emitted
  in interface field order after the table's clock assignment.
- `@pgrollup <statement>` — the field aggregates child rows. The statement is
  written once with `NEW.`; the generator attaches it to `after insert or update`
  on every table whose foreign key points at this field's table, and emits the
  `after delete` variant by substituting `OLD.` for `NEW.`.
- `@createdAt` — the row's creation moment. A bare marker on a `Date` field: the
  column becomes `not null default now()`, and no create or patch writes it. See
  `docs/timestamps.md`.
- `@updatedAt` — the row's last-write moment. A bare marker on a `Date` field: the
  column becomes `not null default now()`, and every write assigns
  `NEW."<field>" := now()` in the table's trigger. See `docs/timestamps.md`.
- `@default <expression>` — a database column default, written verbatim into the DDL. The field may be optional, and a create may omit it; the SQL then writes `default` in place of the value, so the database fills it. `<name>InsertSchema` accepts the field whether or not it is supplied, and a patch may set it like any other column. May accompany `@computed`: the default covers the insert path, the trigger every write, and the two agree on insert. A `@version` field is the exception: a defaulted version stays out of a create, since its default is the first revision. See `docs/repositories.md`.
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
- `@version` — the optimistic-lock column. Omitted on insert (the `@default`
  supplies the first revision) and written on update as the caller's
  precondition; a `before update` trigger validates and increments it. At most
  one per interface, the field type must be `Version`, and it is exclusive with
  `@computed`. See `docs/versioning.md`.
- `@queryfilter` — a bare marker that makes the field a filter of the entity's
  generated reads. A filter is a set matched with `in (…)`; several are combined
  with `and`. Scalar fields only; a branch field may not carry it, and it is
  redundant on the `@primaryKey` field, which is a filter by default. See `docs/queries.md`.
- `@queryorderby` — makes the field an ordering key of the entity's generated
  reads. A bare marker whitelists the field; `@queryorderby default asc|desc`
  also makes it the entity's default ordering (at most one per interface).
  Scalar fields only; a branch field may not carry it. See `docs/queries.md`.
- `@where <op>…` — whitelists the comparison operators the field may be narrowed
  with, space-separated, one or more of `eq`, `ne`, `gt`, `gte`, `lt`, `lte`.
  The list is required: a bare `@where` is a lint finding. Scalar fields only; a
  branch field may not carry it. See `docs/queries.md`.

Interface tags:

- `@table <name>` — the table name. Defaults to the snake_cased interface name.

Type tags:

- `@primitive` — a bare marker on a type alias that identifies it as a scalar
  value type rather than an entity. Applied to the aliases in
  `packages/spec/src/primitives/`. A `@primitive` type must carry a matching
  `@zod` and `@pgtype`; the marker itself takes no value. See `docs/primitives.md`.
- `@zod <expression>` — the type's Zod schema, written verbatim and never
  evaluated by the spec, such as `z.uuid()` or
  `z.uuid().brand<"Something">()`. It is what gives a primitive a runtime
  counterpart to its compile-time brand. At most one per type alias.
- `@pgtype <sql-type>` — the storage type a generator maps the alias to, such as
  `uuid` or `decimal`. The spec declares *what* the value is stored as; a
  generator reads the tag rather than knowing the domain type by name, so adding
  a primitive does not require editing the backend. `@primitive` types must
  carry it. See `docs/primitives.md`.

Type tags sit on a type alias and are validated as a group: `@primitive` types
must declare `@zod` and `@pgtype`, and any tag outside the three is reported. A
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
How the value arrives is the mechanism tag beside it: a generated column, a
trigger, or a rollup. Everything else is an ordinary field — a key the
application assigns, a column with a `@default` — and no tag marks it. The clock
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
The key is a normal scalar field: it is selectable, and it takes `@queryfilter`
like any other, which is how a read filters by a relation. The `@relation` field
itself may not carry `@queryfilter`; filtering on the related record's *columns*
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
 * @pgtrigger NEW."netAmount" := round(NEW."quantity" * NEW."unitPrice", 2)
 */
```

Three mechanisms, chosen by what the expression needs:

- `@pgvirtual` — a `generated always as (…) virtual` column. Cheapest to
  maintain and impossible to leave stale, but constrained: same-row columns
  only, immutable functions only, no referencing another generated column, and
  no index on the result.
- `@pgtrigger` — a `before insert or update` statement. Freer than a generated
  column (it may read other columns the trigger assigned earlier in the same
  pass) and indexable.
- `@pgrollup` — a cross-table aggregate. The only mechanism that can read another
  table, and the only one written once for many child tables.

`invoice.totalAmount` is the one `@pgvirtual` field: it is a same-row sum of two
regular columns. `invoice.netAmount`/`taxAmount` are `@pgrollup` because a sum
over `invoice_row` cannot be a generated column. The `invoice_row` amounts are
`@pgtrigger` because `taxAmount` reads `netAmount` and `totalAmount` reads both,
and a generated column cannot reference another generated column.

## Why the row amounts are trigger assignments

The chain is `netAmount`, then `taxAmount`, then `totalAmount`. Two properties of
generated columns forbid expressing it directly:

- A generated column's expression may not reference another generated column.
- A `before` trigger sees `NEW."<generated column>"` as null, so the later
  assignments could not read `netAmount` even if it were virtual.

Making the row amounts virtual would mean inlining `round(NEW."quantity" *
NEW."unitPrice", 2)` into all three expressions. The trigger keeps one
expression per amount and preserves the order, and `@pgtrigger` makes that
choice explicit in the spec.

## Why the rollup amounts are written

An invoice is a legal document, so an issued amount should not change when
rounding or tax rules change. A trigger writes the rolled-up value once, when a
child row changes, and the column keeps it. `@pgvirtual` is used only where the
value is a pure function of two columns on the same row, so a recomputation from
those columns always reproduces the same figure.

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

- **An aggregate cannot be `@pgvirtual`.** Postgres forbids a generated column
  from referencing another table, so `Invoice.netAmount` (a sum over
  `invoice_row`) must be `@pgrollup`.
- **A generated column cannot read another generated column,** and a `before`
  trigger cannot read one either — `NEW."<col>"` is null for a virtual column.
  The `invoice_row` amounts stay `@pgtrigger` for this reason.
- **Trigger order is part of the contract.** For `invoice_row`: `netAmount`,
  then `taxAmount`, then `totalAmount`. Reordering the fields produces stale
  values rather than an error.
- **A `@pgrollup` statement is written once and mirrored.** The generator emits
  the `after delete` variant by substituting `OLD.` for `NEW.`, so a statement
  spelled with `OLD.` is a lint finding. The statements hardcode the foreign key
  column name `"invoiceId"`, which is why they only work for a child whose key
  column has that name.
- **The invoice total is not set by the rollup.** The rollups write `netAmount`
  and `taxAmount` only; `totalAmount` is virtual, so it recomputes on read. No
  ordering is load-bearing there, which is the point of choosing `@pgvirtual`.
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
  expression index spelled out or the `@pgtrigger` mechanism instead.

## Deliberately not implemented

- **Views for a read-time projection.** A derived view would recompute on every
  read; the mechanisms above cover what the spec needs today, and nothing emits
  a view.
- **A cross-table `@pgvirtual`.** Postgres rejects it outright, so no generator
  support is planned.
- **Multi-currency rows.** Rows may eventually be issued in currencies other
  than the invoice's, which needs an exchange rate per row and a converted total
  in the invoice currency. The `@pgtrigger`/`@pgrollup` expressions would gain
  rate-aware arithmetic, and the rounding/tax ordering (convert-then-tax vs
  tax-then-convert) would need to be pinned down.
- **Rate dates.** Invoices normally lock an exchange rate as of a specific date,
  which is frequently not `issueDate`.

## Wiring

1. A generator parses the `@` tags from `packages/spec/`.
2. For each `@computed` field it reads the mechanism tag off the field itself:
   `@pgvirtual` becomes a generated column, `@pgtrigger` a `before insert or
   update` assignment, `@pgrollup` an `after insert or update` and `after
   delete` pair on each child table.
3. `@createdAt` becomes a `default now()`, and `@updatedAt` that plus a trigger
   assignment.

`packages/backend/scripts/generate-postgres-schema.ts` implements all of the
above. See `docs/schema-generation.md`.

## Why the expressions live in the spec

The mechanism tags are deliberately Postgres-specific, in the same way `@pgtype`
is: `packages/spec/` names the storage the backend uses rather than describing a
second, abstract vocabulary that only one backend consumes. The dialect-neutral
part is `@computed`, which says `this is derived` and drives the insert and patch
schemas; the `@pg*` tag beside it says how this database materializes it.

That means a different backend needs its own mechanism tags, exactly as it needs
its own `@pgtype` mapping. There is no name indirection to resolve and no
registry to keep in step, so a field's expression sits next to the field it
describes:

```
/**
 * @fieldName Total amount
 * @computed
 * @pgvirtual "netAmount" + "taxAmount"
 * @widget number
 */
totalAmount?: Money;
```

## Linting

`pnpm lint:spec` runs `packages/spec/scripts/lint-spec.ts`, which walks the
interfaces in `packages/spec/` with ts-morph. Run it whenever a tag changes.

Enforced:

- Tags are limited to the field and interface tags listed above.
- Retired tags (`@generated`, `@readonly`, `@type`, `@values`, `@formula`)
  report their replacement.
- `@fieldName` and `@widget` are required; `@widget` must be a known widget.
- `@computed` takes no parameters; the expression sits in the mechanism tag
  beside it.
- A mechanism tag (`@pgvirtual`, `@pgtrigger`, `@pgrollup`) requires `@computed`,
  carries a non-empty expression, and at most one may appear on a field.
- `@pgrollup` may not contain `OLD.`, which the generator would otherwise
  substitute twice.
- `@createdAt` and `@updatedAt` take no value, sit on a `Date` field, are
  mutually exclusive with each other and with `@computed`,
  `@default`, `@version`, and the mechanism tags, and may appear at most once per
  interface.
- `@inlined` requires an entity name and is mutually exclusive with `@relation`
  and `@children`.
- `@primaryKey` is a bare marker on a scalar field, and may appear on several
  fields of one interface to form a composite key; `@foreignKey` requires the
  interface it references and sits on a single scalar field. The two are
  mutually exclusive. See "`@primaryKey` and `@foreignKey`".
- `@queryfilter` is a bare marker on a scalar field; a branch field may not
  carry it, and it must not be written on the `@primaryKey` field, which is a
  filter already. See `docs/queries.md`.
- `@queryorderby` is a bare marker on a scalar field, or `default asc|desc`; a
  branch field may not carry it, and at most one field may declare the default.
  See `docs/queries.md`.
- `@where` requires at least one operator, each one of `eq`, `ne`, `gt`, `gte`,
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
  composite key contributes one filter per column. Writing `@queryfilter` on a
  key field is therefore a lint finding, not a second way to say the same thing:
  the default has one spelling.
- **`@queryfilter` is checked structurally, not by type.** The linter rejects it
  on a branch field (a `@relation`/`@children`/`@inlined` marker), on the
  primary key, and on a value, but it does not resolve the field's type: the
  generated read types the filter from the field's own type, so a non-scalar
  would surface there.
- **`@relation` and its `@foreignKey` field are paired by the generator, not the
  linter.** The linter checks tags; the cross-field rule is enforced when the
  table model is built, so the diagnostic comes from `pnpm generate` with a file
  and line, the same way `@children` without a foreign key does. See
  `docs/schema-generation.md`.
