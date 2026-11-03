# Permissions

`packages/sdk/src/permissions.ts` declares the `PERMISSIONS` const: for each
entity, the infra-level actions it permits. `scripts/sdk/generate-permissions.ts`
writes it, so the file is never edited by hand.

```ts
export const PERMISSIONS = {
    "account": ["create", "upsert", "update", "delete", "query"],
    "widget": ["create", "update", "query", "watch"],
} as const;

export type Permissions = typeof PERMISSIONS;
```

The SDK reads `PERMISSIONS` at runtime, and a consumer imports it from
`sdk/permissions.ts`, as it imports `sdk/specErrors.ts`. The tuples are
`as const`, so each action is a literal type, and `Permissions` names the keys
and actions without needing a value.

## Where the actions come from

An entity's actions are the ones its infra declarations generate. The generator
reads them from the parsed `SpecModel` in `scripts/spec/spec-model.ts`:

| Declaration   | Actions                                                   |
| ------------- | --------------------------------------------------------- |
| `@repository` | the write operations it names: `create`, `upsert`, `update`, `delete` |
| `@queries`    | `query`                                                   |
| `@watch`      | `watch`, whatever scopes it names                         |

The writes come first in their canonical order, then the query, then the watch.
An entity without a `@watch` has no `watch` action.

A `@restRepository`, `@restQueries`, or `@restWatch` adds nothing. It exposes
over REST an action the infra already has, so the permissions name the infra
action once.

Operations (`@operation`) are application logic rather than infra actions, so
they are not listed. An entity deferred with `@todo` generates no infra, so the
generator leaves it out.

## Keys

The key is the entity name with its leading word lowercased, the same name the
SDK gives the entity's API module: `Widget` becomes `"widget"`, and
`WidgetPart` becomes `"widgetPart"`. A leading run of capitals is one word, so
`URLRoute` becomes `"urlRoute"`. Entries follow the entity name order, as every
other generated list does.

## Running it

`pnpm run generate:permissions` writes the file. The pipeline runs it right
after the linter, since it reads only the entity declarations. `--out <file>`
writes elsewhere, as the error generator does. Like the other generated files, a
stale copy is caught by running the generator, not by a check.

## Gotchas

- **Nothing lints the actions.** The const has no tags for the linter to check,
  so a change to a declaration reaches the file only when the generator runs.
