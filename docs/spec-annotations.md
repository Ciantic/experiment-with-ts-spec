# Spec annotations

Field-level JSDoc tags in `spec/` are the machine-readable contract a generator
consumes. This note records what each tag means and how it lands in Postgres.

## Tags

Field tags:

- `@fieldName` — human-readable label. Presentation only.
- `@widget` — suggested UI control (`text`, `number`, `date`, `select`, `table`, `textarea`). Presentation only.
- `@generated` — system-assigned. Not derivable from other fields; not client-supplied.
- `@computed` — derived from other fields or from child rows. Carries `storage=` and `formula=`.
- `@relation <Entity>` — the field holds an entity object, not a scalar. Emits a foreign key column named `<field>Id`.
- `@children <Entity>` — the field holds a child collection. Not a column; the child table carries the foreign key.
- `@unique` — the column is unique.

Interface tags:

- `@table <name>` — the table name. Defaults to the snake_cased interface name.

`@generated` and `@computed` replace the earlier `@readonly`, which conflated the
two. The distinction matters because they produce different column behaviour:
`id` is assigned once and never recomputed, whereas `totalAmount` is a function
of other data.

## `@computed` parameters

```
@computed storage=stored formula=rowNetAmount
```

- `storage=` selects the wrapper the expression is embedded in.
- `formula=` names an entry in `spec/postgres/formulas.ts`. Names are resolved
  there, never inlined into the tag.

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

## Money representation

`Price` is `bigint`, in minor units (cents). The formulas carry the arithmetic
consequences:

- `"quantity"` is `numeric` (fractional quantities such as `1.5` hours), while
  `"unitPrice"` is `bigint`. Their product is `numeric`, which will not fit a
  `bigint` column without an explicit `round(...)::bigint`.
- Rounding is therefore part of the expression, not a hidden default. Every
  money formula rounds explicitly.

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
  maintained by triggers on `invoice_row`, so `invoiceFormulas` stores a `childNew`
  statement (for insert/update) and a `childOld` statement (for delete). Both
  hardcode the foreign key column name `"invoiceId"`, which is why the aggregate
  fragments only work for a child whose key column has that name. They must be
  edited together.
- **The invoice total is not set by the rollup.** The rollups write `netAmount` and
  `taxAmount` only. That update fires the invoice's own before-update trigger,
  which recomputes `totalAmount` from the two. Ordering is therefore load-bearing.
- **Currency is not yet modelled.** `Invoice.currency` was removed and `Price` is
  a bare `bigint`, so amounts currently carry no currency. The doc comments that
  say "in the invoice currency" are forward references to work not yet done.
- **Tags must be on their own line.** A tag written inline on the same line as
  the field, as in `/** @unique */ code: string;`, is not attached to the field
  and is silently ignored by both the generator and the linter. Use a JSDoc block.
- **No tag is a valid state.** A client-supplied field carries no `@generated`
  and no `@computed`. Only present tags are validated.
- **Registry pairing is convention, not enforced.** `Invoice` amounts use
  `invoiceFormulas` and `InvoiceRow` amounts use `rowFormulas`, but the linter
  does not check the pairing. A cross-registry `formula=` would pass.
- **`invoiceTotalAmount` is same-row.** It could live in either registry; it sits
  in `invoiceFormulas` so all three invoice amounts are maintained in one place.

## Deliberately not implemented

- **Views for `storage=derived`.** The mode is accepted and documented, but the
  generator emits nothing for it.
- **`storage=generated`.** Rejected in practice: aggregates cross tables and a
  generated column cannot read another generated column.
- **Multi-currency rows.** Rows may eventually be issued in currencies other
  than the invoice's, which needs an exchange rate per row and a converted total
  in the invoice currency. `formulas.ts` would then gain rate-aware expressions,
  and the rounding/tax ordering (convert-then-tax vs tax-then-convert) would
  need to be pinned down.
- **Rate dates.** Invoices normally lock an exchange rate as of a specific date,
  which is frequently not `issueDate`.

## Wiring

1. A generator parses the `@` tags from `spec/`.
2. For each `@computed` field it resolves `formula=` against `rowFormulas` or
   `invoiceFormulas` in `spec/postgres/formulas.ts`.
3. It wraps the fragment according to `storage=` and emits DDL: a generated
   column, a trigger assignment, or a view projection.
4. `@generated` fields are emitted as ordinary columns the application populates.

`scripts/generate-postgres-schema.ts` implements steps 2 and 3 for
`storage=stored`. See `docs/schema-generation.md`.

It reads `formulas.ts` with ts-morph rather than importing it, because the spec
imports use `.js` extensions that plain `node` cannot resolve to `.ts` files.

## Linting

`pnpm lint:spec` runs `scripts/lint-spec.ts`, which walks the interfaces in
`spec/` with ts-morph. Run it whenever a tag changes.

Enforced:

- Tags are limited to the field and interface tags listed above.
- Retired tags (`@readonly`, `@type`, `@values`) report their replacement.
- `@fieldName` and `@widget` are required; `@widget` must be a known widget.
- `@generated` and `@computed` are mutually exclusive; `@generated` takes no
  parameters.
- `@computed` requires `storage=` (one of `generated`, `stored`, `derived`) and
  `formula=`, and rejects unknown parameters.
- `formula=` must name a key in a registry in `spec/postgres/formulas.ts`.
- Tags may not repeat on a field.

Gotchas:

- **Formula names are read statically, not imported.** The linter parses
  `formulas.ts` with ts-morph so it never has to load the module. This keeps it
  runnable under plain `node` type stripping.
- **The registry initialiser is `as const`.** The object literal is wrapped in an
  `AsExpression`, so a direct `getInitializerIfKind(ObjectLiteralExpression)`
  returns nothing. Read the wrapper or every `formula=` resolves as undefined.
- **Absence of both tags is valid.** Client-supplied fields legitimately carry
  neither, so a rule requiring one would flag almost every field.
- **Node 24 runs the script directly.** `node scripts/lint-spec.ts` relies on
  native type stripping; there is no build step and no `tsx`.
- **Statically decidable only.** The linter checks the tags, not whether a
  formula is semantically right for its field.
