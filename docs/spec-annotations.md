# Spec annotations

Field-level JSDoc tags in `packages/spec/` are the machine-readable contract a generator
consumes. This note records what each tag means and how it lands in Postgres.

## Tags

Field tags:

- `@fieldName` — human-readable label. Presentation only.
- `@widget` — suggested UI control (`text`, `number`, `date`, `select`, `table`, `textarea`). Presentation only.
- `@generated` — system-assigned. Not derivable from other fields; not client-supplied.
- `@computed` — derived from other fields or from child rows. Carries `storage=` and `formula=`.
- `@default <expression>` — a database column default, written verbatim into the DDL. The field may be optional, and the repository does not write the column. May accompany `@computed`: the default covers the insert path, the trigger every write, and the two agree on insert. See `docs/timestamps.md`.
- `@relation` — the field holds a single related entity. A bare marker that adds no column: it navigates through a `<field>Id` field the interface also declares. The entity is the field type, which must be an interface. See `@relation` below.
- `@children` — the field holds a child collection (`<Entity>[]`). Not a column; the child table carries the foreign key. A bare marker; the element type must be an interface.
- `@inlined` — the field holds an entity whose scalar fields are flattened, prefixed with the field name, into snapshot columns on the same table. No foreign key. A bare marker; the field type must be an interface.
- `@unique` — the column is unique.
- `@version` — the optimistic-lock column. Omitted on insert (the `@default`
  supplies the first revision) and written on update as the caller's
  precondition; a `before update` trigger validates and increments it. At most
  one per interface, the field type must be `Version`, and it is exclusive with
  `@generated` and `@computed`. See `docs/versioning.md`.
- `@queryfilter` — a bare marker that makes the field a filter of the entity's
  generated reads. A filter is a set matched with `in (…)`; several are combined
  with `and`. Scalar fields only; a branch field may not carry it, and it is
  redundant on `id`, which is a filter by default. See `docs/queries.md`.
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

- `@formula` — marks a union of string literals as a set of valid `formula=`
  names. Applied to a type alias, not to a field or interface. See
  "Saying what, not how". `TimestampFormula` is cross-cutting rather than
  belonging to one entity, so it sits alone in
  `packages/spec/src/domain/Timestamp.ts`.
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

Type tags sit on a type alias and are validated as a group: `@formula` types are
checked as unions of string literals, `@primitive` types must declare `@zod` and
`@pgtype`, and any tag outside the four is reported. A field never carries a type
tag; an alias never carries a field or interface tag.

`@relation`, `@children`, and `@inlined` are bare markers, like `@generated`:
they take no value. The entity and the cardinality both come from the field
type, so `owner?: Owner` with `@relation` links to `Owner`, and `rows?: Row[]`
with `@children` makes `Row` the child. This removes a second source of truth
that could disagree with the type — a tag naming an entity other than the
field's is not expressible. `@relation` and `@inlined` must be on a single
entity, `@children` on an array of one, and the three are mutually exclusive.

`@generated` and `@computed` replace the earlier `@readonly`, which conflated the
two. The distinction matters because they produce different column behaviour:
`id` is assigned once and never recomputed, whereas `totalAmount` is a function
of other data.

`@generated` says *who* assigns a value, not *how*. On its own it carries no SQL:
it is presentation metadata telling a UI not to offer the field. How the value
arrives is a separate decision — a client-supplied column, a `@default`, or a
`@computed` trigger. The timestamps show two of those spellings; see
`docs/timestamps.md`.

## `@relation`

A `@relation` field is *navigation*: it names the entity on the other side of a
foreign key. The key itself is an ordinary field the interface declares,
named `<field>Id`:

```ts
/**
 * @fieldName Customer
 * @relation
 * @widget select
 */
customer?: Customer;

/**
 * @fieldName Customer ID
 * @generated
 * @widget text
 */
customerId?: CustomerId;
```

The alternative — the tag synthesizing the column — would put one fact in two
places: the tag's entity and the key field's type could disagree. Here the
generator joins the two fields by name, and a mismatch is a diagnostic rather
than a silent second column. Either half alone is also a diagnostic: a
`@relation` without its `<field>Id` field, or a `<field>Id` field whose type
references a table other than the relation's.

Nullability lives on the `<field>Id` field, so a required relation needs a
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
CHECK) but not its `@unique`. `@generated` and `@computed` on the target are
ignored: an inlined value is data, not a derivation. Non-scalar target fields
(entity references or child arrays) are a diagnostic; `@inlined` flattens scalars
only.

## `@computed` parameters

```
@computed storage=stored formula=rowNetAmount
```

- `storage=` selects the wrapper the expression is embedded in.
- `formula=` names a member of a type annotated `@formula`, such as `RowFormula`
  in `packages/spec/src/domain/InvoiceRow.ts` or `InvoiceFormula` in
  `packages/spec/src/domain/Invoice.ts`. The annotation, not a hardcoded list or
  location, is what makes a type a set of names. The Postgres SQL behind a name
  lives in `packages/backend/src/postgres/formulas.ts`; it is never inlined into the tag.

## Storage modes

The same expression text is embedded three ways, differing only by wrapper:

- `generated` — `ADD COLUMN ... GENERATED ALWAYS AS (<expr>) STORED`. Recomputed on every write.
- `stored` — `NEW."x" := <expr>;` inside a `BEFORE` trigger. Recomputed at write time only.
- `derived` — `SELECT ..., <expr> AS "x" FROM ...` in a view. Recomputed on every read.

All amounts in this spec are `storage=stored`.

## Why amounts are `stored`, not `generated`

An invoice is a legal document. A generated column recomputes on every write, so
a change in rounding rules or tax logic would silently change a total that was
already issued. Amounts are computed once, when the invoice is written, then
frozen. `generated` is the one storage mode that breaks this, and it is
deliberately unused for money.

## Column naming

Columns are named exactly as the TypeScript fields, quoted camelCase
(`"unitPrice"`, `"netAmount"`). There is no field-to-column mapping, so the SQL
fragments and the spec fields use identical identifiers. Changing a field name
therefore changes a column name — intentional, since it keeps one name in play.

## Number representation

Every numeric column is `decimal`, from the `Decimal` brand, which the drivers
return as a string. Rounding is therefore part of the formula rather than a
column type:

- `rowNetAmount` is `round(NEW."quantity" * NEW."unitPrice", 2)`, fixing money to
  two decimals.
- `rowTaxAmount` is `round(NEW."netAmount" * NEW."taxRate", 2)`, where `taxRate`
  is a fraction (`0.255` is 25.5%).
- The aggregates need no cast, since `sum` of `decimal` is `decimal`.

Rationale and the alternative that was tried are in `docs/primitives.md`.

## Gotchas

- **Aggregates cannot be `generated`.** Postgres forbids generated columns from
  referencing other tables, so `Invoice.netAmount` (a sum over `invoice_row`)
  can never use `storage=generated`. It is `stored`, written by a trigger.
- **A generated column cannot read another generated column.** `InvoiceRow.taxAmount`
  reads `"netAmount"` and `totalAmount` reads both. Under `storage=generated`
  Postgres would reject this outright. Under `storage=stored` it works, but only
  because the trigger assigns in order.
- **Trigger order is part of the contract.** For `invoice_row`: `netAmount`,
  then `taxAmount`, then `totalAmount`. Reordering the assignments produces
  stale values rather than an error.
- **One aggregate has two child-change spellings.** `Invoice.netAmount`/`taxAmount` are
  maintained by triggers on `invoice_row`, so `invoiceFormulas` in
  `packages/backend/src/postgres/formulas.ts` stores a `childNew`
  statement (for insert/update) and a `childOld` statement (for delete). Both
  hardcode the foreign key column name `"invoiceId"`, which is why the aggregate
  fragments only work for a child whose key column has that name. They must be
  edited together.
- **The invoice total is not set by the rollup.** The rollups write `netAmount` and
  `taxAmount` only. That update fires the invoice's own before-update trigger,
  which recomputes `totalAmount` from the two. Ordering is therefore load-bearing.
- **Currency is not yet modelled.** `Invoice.currency` was removed, so amounts
  currently carry no currency. The doc comments that say "in the invoice
  currency" are forward references to work not yet done.
- **Tags must be on their own line.** A tag written inline on the same line as
  the field, as in `/** @unique */ code: string;`, is not attached to the field
  and is silently ignored by both the generator and the linter. Use a JSDoc block.
- **No tag is a valid state.** A client-supplied field carries no `@generated`
  and no `@computed`. Only present tags are validated.
- **Registry pairing is convention, not enforced.** `Invoice` amounts use
  `invoiceFormulas` and `InvoiceRow` amounts use `rowFormulas` in
  `packages/backend/src/postgres/formulas.ts`, but nothing checks the pairing. The
  generator merges every registry and keys fragments by formula name alone, so a
  cross-registry `formula=` would pass.
- **`invoiceTotalAmount` is same-row.** It could live in either registry; it sits
  in `invoiceFormulas` so all three invoice amounts are maintained in one place.

## Deliberately not implemented

- **Views for `storage=derived`.** The mode is accepted and documented, but the
  generator emits nothing for it.
- **`storage=generated`.** Rejected in practice: aggregates cross tables and a
  generated column cannot read another generated column.
- **Multi-currency rows.** Rows may eventually be issued in currencies other
  than the invoice's, which needs an exchange rate per row and a converted total
  in the invoice currency. `packages/backend/src/postgres/formulas.ts` would then gain rate-aware expressions,
  and the rounding/tax ordering (convert-then-tax vs tax-then-convert) would
  need to be pinned down.
- **Rate dates.** Invoices normally lock an exchange rate as of a specific date,
  which is frequently not `issueDate`.

## Wiring

1. A generator parses the `@` tags from `packages/spec/`.
2. For each `@computed` field it resolves `formula=` against the registries in
   `packages/backend/src/postgres/formulas.ts`, keyed by formula name.
3. It wraps the fragment according to `storage=` and emits DDL: a generated
   column, a trigger assignment, or a view projection.
4. `@generated` fields are emitted as ordinary columns the application populates.

`packages/backend/scripts/generate-postgres-schema.ts` implements steps 2 and 3
for `storage=stored`. See `docs/schema-generation.md`.

It reads `packages/backend/src/postgres/formulas.ts` with ts-morph rather than importing it, so the
generator reads the registries as data and never executes backend code.

## Saying what, not how

The formula names are the spec's vocabulary; the expressions are one database's
implementation of it. Splitting them keeps `packages/spec/` free of SQL:

- `packages/spec/src/domain/InvoiceRow.ts` declares `RowFormula`, and
  `packages/spec/src/domain/Invoice.ts` declares `InvoiceFormula`, each a union of
  the valid `formula=` names annotated `@formula`. Nothing about Postgres appears
  in either file.
- `packages/spec/src/domain/Timestamp.ts` declares `TimestampFormula` (`now`),
  the cross-cutting set used for `updatedAt`. It belongs to no entity, which is
  why it has its own file.
- `packages/backend/src/postgres/formulas.ts` maps each name to its SQL fragment, typed
  `Record<RowFormula, string>`, `Record<InvoiceFormula, …>`, and
  `Record<TimestampFormula, string>`, so adding a name to the spec fails the
  type-check until a fragment is written for it.

The name is the contract a domain field references; the fragment is what the
Postgres generator emits. A different backend would supply its own fragment file
against the same spec unions.

Discovery is by annotation alone. The linter scans `packages/spec/` for
`@formula`-marked types and reads their string-literal members; it holds no file
name and no type name. A new formula family is therefore a new `@formula` union
anywhere under `packages/spec/`, with no tool change.

## Linting

`pnpm lint:spec` runs `packages/spec/scripts/lint-spec.ts`, which walks the
interfaces in `packages/spec/` with ts-morph. Run it whenever a tag changes.

Enforced:

- Tags are limited to the field and interface tags listed above.
- Retired tags (`@readonly`, `@type`, `@values`) report their replacement.
- `@fieldName` and `@widget` are required; `@widget` must be a known widget.
- `@generated` and `@computed` are mutually exclusive; `@generated` takes no
  parameters.
- `@inlined` requires an entity name and is mutually exclusive with `@relation`
  and `@children`.
- `@version` requires the field type to be `Version`, is exclusive with
  `@generated` and `@computed`, and may appear on at most one field per
  interface.
- `@computed` requires `storage=` (one of `generated`, `stored`, `derived`) and
  `formula=`, and rejects unknown parameters.
- `@queryfilter` is a bare marker on a scalar field; a branch field may not
  carry it, and it must not be written on `id`, which is a filter already. See
  `docs/queries.md`.
- `@queryorderby` is a bare marker on a scalar field, or `default asc|desc`; a
  branch field may not carry it, and at most one field may declare the default.
  See `docs/queries.md`.
- `@where` requires at least one operator, each one of `eq`, `ne`, `gt`, `gte`,
  `lt`, `lte`; a branch field may not carry it. See `docs/queries.md`.
- `formula=` must be a member of an `@formula`-annotated type.
- An `@formula` type must be a non-empty union of string literals.
- Tags may not repeat on a field.

Gotchas:

- **Formula names are discovered, not listed.** The linter scans `packages/spec/` for
  `@formula`-annotated types with ts-morph and reads their string-literal
  members, so it never loads a module and knows no file or type name. This
  keeps it runnable under plain `node` type stripping.
- **`@formula` is a type tag, not a field tag.** It is absent from the field and
  interface tag sets, so writing it on a field or interface reports "not a
  recognised tag".
- **The fragment registries are plain object literals.** The generator's static
  reader also accepts an `as const` wrapper, since fixtures use one, but the real
  `packages/backend/src/postgres/formulas.ts` relies on its `Record<…>` annotation instead.
- **Absence of both tags is valid.** Client-supplied fields legitimately carry
  neither, so a rule requiring one would flag almost every field.
- **Node 24 runs the script directly.** `node scripts/lint-spec.ts` relies on
  native type stripping; there is no build step and no `tsx`.
- **Statically decidable only.** The linter checks the tags, not whether a
  formula is semantically right for its field.
- **`id` is a filter without a tag.** `spec-model.ts` marks the field named `id`
  as `queryfilter` when it parses an entity, because `id` is the primary key
  every entity has. Writing `@queryfilter` on it is therefore a lint finding,
  not a second way to say the same thing: the default has one spelling.
- **`@queryfilter` is checked structurally, not by type.** The linter rejects it
  on a branch field (a `@relation`/`@children`/`@inlined` marker), on `id`, and
  on a value, but it does not resolve the field's type: the generated read types
  the filter from the field's own type, so a non-scalar would surface there.
- **`@relation` and its `<field>Id` field are paired by the generator, not the
  linter.** The linter checks tags; the cross-field rule is enforced when the
  table model is built, so the diagnostic comes from `pnpm generate` with a file
  and line, the same way `@children` without a foreign key does. See
  `docs/schema-generation.md`.
