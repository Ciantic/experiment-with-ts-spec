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
not catch an invoice id passed where a row id was expected. `Decimal` brands
`string` the same way.

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

## Numbers

Every numeric value in the model is a decimal carried as a string:

```typescript
export type Decimal = string & { readonly __decimal: true };

export type Price = Decimal & { readonly __brand: "Price" };
export type Quantity = Decimal & { readonly __brand: "Quantity" };
export type TaxRate = Decimal & { readonly __brand: "TaxRate" };
```

Money (`unitPrice`, `netAmount`, `taxAmount`, `totalAmount`) is `Price`, counts are
`Quantity`, and ratios are `TaxRate`. All are `decimal` in Postgres; the brands
only exist in the type system.

Why the brands:

- `"0.255"` is a plausible price *and* a plausible tax rate. Without brands, a
  value could be assigned to a field of the wrong meaning and the compiler would
  say nothing.
- Each branded type refines `Decimal`, so a function accepting `Decimal` accepts
  any of them, while a function accepting `Price` rejects a `Quantity`.

- **Exact.** Postgres `decimal` is arbitrary-precision, so no binary or scale loss.
- **String, not number.** The driver returns `decimal` as a string anyway, so the
  type matches the runtime value. `Number` conversion would reintroduce the
  precision loss the type exists to avoid.
- **Nested type, not number.** `JSON.stringify` works on strings, unlike `bigint`.

Conventions:

- Amounts are in the currency's major unit with two decimals (`"12.50"`).
- `quantity` is a plain decimal count (`"1.5"`).
- `taxRate` is a fraction, not a percentage: `"0.255"` is 25.5%. Three decimals
  are needed for rates such as 8.875%, and `decimal` carries them exactly.

This replaced three separate types (`Price` as an integer `bigint` in minor
units, `Quantity`, `TaxRate`). The integer approach was exact but required a
scale convention per field, and mixed two representations in one model.

Gotchas:

- **Never reuse a brand property name in an intersection.** `A & { __brand: "X" }`
  where `A` already declares `__brand` intersects the two literal types, which
  collapses to `never`. Every branded type then becomes structurally identical and
  the branding silently stops working — the compiler accepts anything. That is why
  the base type uses `__decimal` and the refinements use `__brand`.
- **Branding is not validation.** Nothing checks that the string parses as a
  number. Parsing and rounding are the caller's job.
- **Construction needs a cast.** Nothing produces a branded value on its own, so
  values are cast at the boundary where they are parsed or received.
- **Do not do arithmetic in JS without parsing.** `"1.5" * 2` coerces to a number
  and loses the guarantee; use a decimal library or let SQL compute it.
- **Rounding lives in the SQL, not the type.** `round(..., 2)` in the formula is
  what fixes the scale of a stored amount. See `docs/schema-generation.md`.
- **There is no currency on amounts.** See `docs/spec-annotations.md` for the
  multi-currency work that was deferred.

## Deliberately not implemented

- **Currency on amounts.** Amounts currently carry no currency. See
  `docs/spec-annotations.md` for the multi-currency work that was deferred
  (per-row exchange rate, converted totals, rate dates).
