# Primitives

Value types in `packages/spec/src/primitives/`. These are scalars, not entities;
entities live in `packages/spec/src/domain/`.

## Annotations

Every alias in this folder carries three type-level tags, described in
`docs/spec-annotations.md`:

```typescript
/**
 * @primitive
 * @pgtype uuid
 * @zod z.uuid().brand<Name>()
 */
export type BrandedId<Name extends string> = GUID & Brand<Name>;
```

- `@primitive` marks the alias as a scalar value type, not an entity. It is a
  bare marker and takes no value.
- `@pgtype` is the Postgres type a generator maps the alias to (`uuid`, `decimal`,
  `text`, `int8`). It is what keeps the storage mapping in the spec: the backend
  reads the tag instead of hardcoding domain type names, so a new primitive is a
  spec-only change.
- `@zod` is the type's Zod schema, written verbatim. The tag is text a generator
  consumes; the schema is never evaluated in this package. It is what gives a
  brand that exists only in the type system a runtime counterpart that can
  validate a value at the boundary.

Zod is a **type-only** dependency: `Brand` — the spec's alias for Zod's `$brand`
— is imported with `import type`, so it is erased at runtime and `packages/spec/`
still ships no executable code. Because the schema expression and the type must
agree on the *same* brand symbol, the workspace must resolve a single copy of
Zod — two copies declare two `unique symbol`s and the brands silently stop
matching.

Each schema stays self-contained. `Money`, `Quantity`, and `TaxRate` each write
out the decimal string shape and then apply their brands rather than importing
`Decimal`'s schema, so a primitive has no runtime dependency on another.

The schema mirrors the alias:

- A **branded** alias (`Email`, `Decimal`, `Money`, `Version`, `BrandedId`) gets
  the matching `.brand<…>()`. The brand is the whole point of the alias, so the
  schema must reproduce it. `Money` refines `Decimal`, so its schema chains the
  base brand first, `.brand<"Decimal">().brand<"Money">()`, and
  `z.infer<typeof moneySchema>` is then assignable to `Money` with no cast.
- A **closed** union gets `z.enum([...])`.
- An **open** union (`Unit`, `Currency`, `Language`, `EInvoiceOperator`) gets
  `z.enum([...]).or(z.string())`, not a brand — the alias is a plain string with
  hints, not a nominal type. It validates the same as `z.string()`, but keeps the
  known members visible to schema introspection (OpenAPI, `z.toJSONSchema()`).

A `.brand<>()` on an unbranded alias is wrong: it claims a nominal type the
alias does not have, so the runtime schema and the compile-time type disagree.

## Branding

Brands come from Zod, surfaced in the spec as `Brand`, not a hand-rolled
property:

```typescript
export type Brand<Name extends string> = $brand<Name>;

export type BrandedId<Name extends string> = GUID & Brand<Name>;
```

`Brand<T>` (Zod's `$brand<T>`) is a phantom property keyed by a module-private
`unique symbol`, so it exists only in the type, never at runtime, and cannot
collide with a real property. It is the single place the spec reaches for Zod's
brand; every branded primitive imports it from
`packages/spec/src/primitives/Brand.ts` rather than `$brand` directly. It is what
separates `InvoiceId` from `InvoiceRowId`. A plain alias
(`type InvoiceId = GUID`) would not: aliases are structurally interchangeable, so
the compiler could not catch an invoice id passed where a row id was expected.
`Decimal` brands `string` the same way.

Zod's brand has two payoffs:

- **The schema and the type agree.** `z.infer<typeof x>` produces `$brand<…>`,
  which is exactly what `Brand<…>` aliases, so a parsed value is already the spec
  type with no cast.
- **Brands accumulate.** `$brand`'s payload is a mapped object, so intersecting
  two brands yields `{ Decimal: true; Money: true }`, not `never`. A shared
  property name with a literal type would collapse on intersection; the mapped
  form does not, so a value can carry several brands without a per-brand split.

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
export type Decimal = string & Brand<"Decimal">;

export type Money = Decimal & Brand<"Money">;
export type Quantity = Decimal & Brand<"Quantity">;
export type TaxRate = Decimal & Brand<"TaxRate">;
```

Money (`unitPrice`, `netAmount`, `taxAmount`, `totalAmount`) is `Money`, counts are
`Quantity`, and ratios are `TaxRate`. All are `decimal` in Postgres; the brands
only exist in the type system.

Why the brands:

- `"0.255"` is a plausible price *and* a plausible tax rate. Without brands, a
  value could be assigned to a field of the wrong meaning and the compiler would
  say nothing.
- Each branded type refines `Decimal`, so a function accepting `Decimal` accepts
  any of them, while a function accepting `Money` rejects a `Quantity`.

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

Gotchas:

- **Keep one copy of Zod in the workspace.** Zod's brand is a `unique symbol`
  declared per module, so a second resolved copy makes its brands mutually
  unassignable. Deduplication is what keeps `z.infer` and the spec types in step.
- **Branding is not validation.** Nothing checks that the string parses as a
  number. Parsing and rounding are the caller's job.
- **Construction needs a cast.** Nothing produces a branded value on its own, so
  values are cast at the boundary where they are parsed or received.
- **Do not do arithmetic in JS without parsing.** `"1.5" * 2` coerces to a number
  and loses the guarantee; use a decimal library or let SQL compute it.
- **Rounding lives in the SQL, not the type.** `round(..., 2)` in the expression is
  what fixes the scale of a stored amount. See `docs/schema-generation.md`.
- **There is no currency on amounts.** See `docs/spec-annotations.md` for the
  multi-currency work that was deferred.

## Version

`Version` is the one numeric primitive that is not a `Decimal`:

```typescript
export type Version = bigint & Brand<"Version">;
```

It is an optimistic-lock counter. `bigint` rather than `number` because the
`int8` column already comes back as a `bigint` from both drivers, and because
`version + 1n` is exactly the arithmetic a branded string cannot express. The
brand keeps a revision distinct from a `Quantity`. See `docs/versioning.md`,
including the `JSON.stringify` caveat that comes with `bigint`.

## Deliberately not implemented

- **Currency on amounts.** Amounts currently carry no currency. See
  `docs/spec-annotations.md` for the multi-currency work that was deferred
  (per-row exchange rate, converted totals, rate dates).
