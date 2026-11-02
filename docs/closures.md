# Closures

A function that returns handlers also returns everything those handlers read
from its scope. That is a closure factory:

```ts
export function createWidgetStore(db: SqlExecutor): WidgetStore {
    const byId = new Map<string, Widget>();
    return {
        find: (id) => byId.get(id),
        save: (widget) => {
            byId.set(widget.id, widget);
            return db.write(widget);
        },
    };
}
```

The `Map` is state, but nothing in `WidgetStore` says so: not the type, not an
own property, not a debugger's field list. A class names it:

```ts
export class WidgetStore {
    readonly #byId = new Map<string, Widget>();

    constructor(private readonly db: SqlExecutor) {}

    find(id: string): Widget | undefined {
        return this.#byId.get(id);
    }

    save(widget: Widget): Promise<void> {
        this.#byId.set(widget.id, widget);
        return this.db.write(widget);
    }
}
```

## The rule

`pnpm lint` runs Oxlint with `closures/factory-closure` from
`scripts/oxlint/closures.ts`:

- An exported function is reported when a value it returns can keep a function
  literal that reads a local binding of the factory. A function declaration, an
  initialized `const`, and a default export are all checked.
- Parameters and imports are inputs rather than state, so they are not counted.
- A function returned directly, placed on a returned object or array, or passed
  to a free call such as `createServer(handler)` is treated as kept.
- A function passed to an ordinary method call such as `items.map(…)` or
  `db.transaction(…)` is treated as run and discarded, so it is not reported. A
  method that registers its argument — `on`, `addEventListener`, `subscribe`,
  `register`, `set`, `add`, `push`, and the like — is treated as keeping it.

The rule is a suggestion and it is syntactic. It cannot see through a helper
that retains a callback, and it assumes an unknown method runs its callback
immediately. A warning means "this function is a closure factory; check whether
the closure owns state", not "this is a bug".

To accept one factory, put the directive on the line above it and give the
reason, so the next reader does not have to reverse-engineer it:

```ts
// oxlint-disable-next-line closures/factory-closure -- the table is built once and never written
export function createWidgetLookup(rows: Widget[]): WidgetLookup {
```

Oxlint ignores the prose after `--`; a reader does not.

## When to use a class

A value that owns mutable state or a lifecycle is a class: an executor, a
listener registry, an event stream. The class gives the state a name, a
constructor that establishes its invariant, and a `#field` that only its
methods can reach.

A value that is part of the API is a class even when its dependencies are
immutable. A router, a server, and a client each get a name the entry point and
the tests can hold, and an interface can describe; their fields are `readonly`
and the constructor is the only place that assembles them. A short-lived helper
that builds a value and returns it stays a function.

`scripts/oxlint/closures.test.ts` drives the rule with in-memory fixtures, so
the test asserts the rule's contract rather than the repository's current
factories.
