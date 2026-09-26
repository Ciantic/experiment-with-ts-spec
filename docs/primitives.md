# Primitives

Value types in `spec/primitives/`. These are scalars, not entities; entities live
in `spec/domain/`.

## Branding

`BrandedId<Name>` produces a GUID that is nominally distinct per name:

```typescript
export type BrandedId<Name extends string> = GUID & { readonly __brand: Name };
```

The `readonly __brand` property exists only in the type, never at runtime, and is
what separates `InvoiceId` from `InvoiceRowId`. A plain alias (`type InvoiceId =
GUID`) would not: aliases are structurally interchangeable, so the compiler could
not catch an invoice id passed where a row id was expected. `Price` brands
`bigint` the same way.

Cost: values must be cast at the boundary where they are constructed or parsed,
because nothing produces a branded value on its own.

## Open literal unions

`Unit` and `Currency` accept a known set of literals *and* any other string:

```typescript
export type Unit = "hours" | "pieces" | "kg" | (string & {});
```

Two things make this work, and both are easy to get wrong:

- **Plain `string` would destroy the union.** `"hours" | string` collapses to
  `string`, losing both autocomplete and narrowing.
- **`string & {}` does not collapse it.** The intersection is assignable to and
  from `string`, but is not *identical* to it, so TypeScript keeps the union and
  the literal members stay visible.

Narrowing still works for the known members (`if (unit === "hours")`), but a
`switch` over them still needs a `default`, since the open branch is never
excluded.

Some lint configurations flag `{}` under `ban-types`; `Record<never, never>` is
the equivalent spelling if that comes up.

## Money

`Price` is `bigint` in the currency's smallest indivisible unit (cents), so no
rounding is lost. Consequences:

- `JSON.stringify` throws on `bigint`, so amounts need a decimal-string
  representation on the wire and conversion at the edge.
- Arithmetic mixes with `number` awkwardly: `quantity` is a plain `number`
  (fractional quantities such as `1.5` hours are allowed), so deriving a line
  total needs an explicit conversion and an explicit rounding rule.
- `Price` does not know its own currency. The earlier
  `{ amount: bigint; currency: Currency }` shape made amounts self-describing but
  was reverted when exchange rates were deferred.

## Deliberately not implemented

- **Currency on amounts.** Amounts currently carry no currency. See
  `docs/spec-annotations.md` for the multi-currency work that was deferred
  (per-row exchange rate, converted totals, rate dates).
