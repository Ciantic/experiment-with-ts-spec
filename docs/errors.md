# Errors

## The hierarchy

The errors are three modules in `packages/sdk/src/`, outside the generated
schema barrel; the transport re-exports them and the backend imports them by
path. A class is shared because the same failure has to be catchable in the
backend and in the client: the code that throws it and the code that re-raises
it from a response name one class, not two mirrors.

- `errorBase.ts` — `AppError`, the base of the errors the server raises and of
  the one the client raises when it cannot classify a response, and
  `apiErrorBody`, the body a failure becomes.
- `builtinErrors.ts` — the classes this package raises itself: a request the
  router refuses, a write that matched no row, a driver result it cannot read.
- `specErrors.ts` — the classes the spec's `@throws` tags declare, written by
  `packages/sdk/scripts/generate-errors.ts`.

`errors.ts` is the entry: it re-exports both sets, merges their registries into
one kind table, and rebuilds an error from a response body. The split keeps
`errorBase.ts` free of generated imports, so neither generated file imports the
other.

| Class | Wire kind | Status | Raised when |
| --- | --- | --- | --- |
| `AppError` | — | — | base of every error the API reports |
| `RequestError` | `request` | 400 | a request the server refuses before a handler |
| `NotFoundError` | `not-found` | 404 | no route serves the method and path |
| `ValidationError` | `validation` | 400 | the route's schema refuses the decoded argument |
| `PayloadTooLargeError` | `payload-too-large` | 413 | a body past the transport's 1 MB cap |
| `BadGroupError` | `bad-group` | 400 | a group body is malformed before any call runs |
| `QueryError` | `query` | 400 | a read names a field, filter, order, or page the query model refuses |
| `ConflictError` | — | 409 | base of a write that matched fewer rows than the call addressed |
| `VersionConflictError` | `version-conflict` | 409 | a versioned patch or upsert claims a version the row has moved past |
| `NoMatchingRowError` | `no-matching-row` | 409 | a versionless patch addresses a key that is not there |
| `ShortWriteError` | `short-write` | 500 | a create or snapshot upsert writes fewer rows than it carried |
| `DriverResultError` | `driver-result` | 500 | `affectedRows` or `resultRows` reads a result the driver did not shape |
| `SavepointOptionsError` | `savepoint-options` | 400 | a nested boundary is asked for transaction options |
| `NotImplemented` | `not-implemented` | 501 | a call is scaffolded but has no implementation yet |
| `HttpError` | `http` | response's status | the SDK cannot classify a non-2xx body |

`ConflictError` carries the SQLSTATE `"40001"`, the code clients already treat as
retriable, so a repository conflict and a driver conflict reach the router as the
same `409`. `NoMatchingRowError` shares the code because both ways of matching no
row take the same recovery: re-read, then retry (`docs/versioning.md`).
`HttpError` lives in the SDK, not in the shared module: it is only what the
client falls back to.

The classes above are built in. A class a spec declares with `@throws` is written
to `specErrors.ts` and joins the same table:

| Class | Wire kind | Status | Declared by |
| --- | --- | --- | --- |
| `WidgetDetailsError` | `widget-details` | 422 | `WidgetOperations.sendWidget` |

`UsageError` and `MockDataError` stay in `packages/backend/src/errors.ts`. They
extend `AppError` but never reach an HTTP response — one is a command line the
entry point cannot interpret, the other is spec mock data with no generated
create repository — so no client class mirrors them.

## The wire

A failed response is plain JSON. `apiErrorBody` in the shared module writes the
body the SDK reads:

```json
{
  "error": "no row of widget is at the version this patch supplied for 3f…",
  "kind": "version-conflict",
  "path": [1, 0],
  "issues": ["…"]
}
```

`error` is the message, `kind` is the stable token a client rebuilds the class
from, `path` names the group entry that failed, and `issues` carries a refused
argument's report. `path` and `issues` are present only when they apply. An
unclassified failure — a plain `Error`, or a driver error matched by its
SQLSTATE — has no `kind`, so the client keeps it as an `HttpError`.

`kind` is deliberately not the class name. It is the wire contract, so renaming
a class does not change what a client sends or expects. `ERROR_CLASSES` in
`errors.ts` is the one table mapping a kind to a class. It is the merge of
`BUILTIN_ERROR_CLASSES` and `SPEC_ERROR_CLASSES`, so a built-in kind needs a
class in `builtinErrors.ts` and an entry in its table, and a spec kind needs an
`@throws` tag. Every class accepts the same `(message, options)` constructor.

## The SDK

`createHttpClient` parses the body of a non-2xx response and calls
`apiErrorFromBody`. A known `kind` becomes its class with the response's status,
and the message, path, and issues the body carried. An absent or unknown kind
becomes `HttpError`, which extends `AppError` and keeps the raw `body`. So:

```ts
try {
    await exec(http, updateSupplier([patch]));
} catch (thrown) {
    if (thrown instanceof VersionConflictError) {
        // re-read, then retry
    }
    if (thrown instanceof AppError) {
        // any failure the API reported, typed or not
    }
}
```

`packages/sdk/src/index.ts` re-exports `packages/sdk/src/http.ts`, which
re-exports the shared module, so a client imports `AppError`,
`VersionConflictError`, and `HttpError` from `sdk/index.ts`.

An `attempt` group does not throw its inner failure; it reports it as a value.
That value carries the same `kind` as the class the failure would have become,
so a caller can tell a tolerated version conflict from any other failure
(`docs/transactions.md`). It is a plain object, not an `AppError` instance,
because it did not fail the request.

## The backend

`errorFrom` in `packages/backend/src/http/http-response.ts` is the one place a
thrown error becomes a response: `statusFor` picks the status, and
`apiErrorBody` writes the body. `statusFor` returns an `AppError`'s own status
first; only an error that is not one is matched against the driver's `code`
(`docs/rest-api.md`).

Inside a group, `GroupFailure` wraps the handler's error, copies its `kind`,
`issues`, and status, and adds the tree path of the entry that raised. The SDK
therefore reconstructs the original class with the group coordinates attached,
rather than a generic group error.

A driver failure is not wrapped in an `AppError`. It reaches the router with the
SQLSTATE the driver gave it, and `statusFor` maps it through the table in
`docs/rest-api.md`. The same applies to `DriverResultError`, which
`resultRows` raises while a repository reads a statement's returned rows.

## The JSDoc contract

Every `throw new SomeError(…)` names that error in the JSDoc of an enclosing
function:

```ts
/**
 * Patch `supplier` rows at the version each row claims.
 * @throws {VersionConflictError} when a row is not at the version the patch supplied
 */
export async function updateSupplier(db: SqlExecutor, rows: SupplierPatch[]): Promise<void> {
```

The tag names the class and gives the reason it was thrown. A public function
may document a throw inside a private or nested function it contains, so a
generated repository documents the `throw` inside its `write` closure once.

`pnpm lint` runs Oxlint with two rules from `scripts/oxlint/errors.js`:

- `errors/throws-jsdoc` reports a `throw new X(…)` when no enclosing function's
  JSDoc has `@throws {X} with a reason`. The rule walks the enclosing functions,
  so the outermost declaration may carry the tag for a nested closure.
- `errors/no-plain-error` reports a `throw` that constructs the base `Error`,
  including `Object.assign(new Error(…), …)`.

Both rules are syntactic: they read the `throw` statements in a file and do not
trace calls. An error that reaches a function only through another call is
documented by hand where that matters. Test files and scripts are exempt, since
their throws are fixtures and tooling failures rather than API contract.

## Errors the spec declares

`pnpm generate:errors` reads every `@throws` an operation declares and writes
`packages/sdk/src/specErrors.ts`:

```ts
/**
 * @throws {WidgetDetailsError} status=422 when the widget doesn't have enough details to be sent
 */
sendWidget(ctx: T, opts: { widget: Widget }): Promise<Widget>;
```

becomes

```ts
/** When the widget doesn't have enough details to be sent. */
export class WidgetDetailsError extends AppError {
    constructor(message: string, options: AppErrorOptions = {}) {
        super(message, { kind: "widget-details", status: 422 }, options);
    }
}

export const SPEC_ERROR_CLASSES: Record<string, new (message: string, options?: AppErrorOptions) => AppError> = {
    "widget-details": WidgetDetailsError,
};
```

The tag carries everything the class needs:

- **The name** is the class. It is shared by every tag that names it, so two
  operations raising the same failure declare it once between them.
- **`status=`** is the response status, `400` to `599`, and defaults to `400`.
  A tag that names the same class at two statuses is a finding.
- **The rest of the tag** is the reason, and becomes the class's doc comment. It
  is documentation: the tag does not narrow the method's type, and the
  implementation is what throws the instance.
- **The wire kind** is derived from the name — `WidgetDetailsError` becomes
  `widget-details` — and is what a client rebuilds the class from.

The generator reports a name that is not a class name, a status outside the
range, a parameter other than `status=`, and a name or kind a built-in error
already answers for. A finding stops the run before the module is written.

Because the module is generated in full, deleting a `@throws` removes its class
on the next run. The hand-written code that throws it then fails to compile,
which is the migration: either the tag comes back or the throw goes away.

The classes are registered through `SPEC_ERROR_CLASSES`, which `errors.ts`
merges, so nothing else has to be edited to make one catchable on both sides.

## Generated repositories

A generated operation declares the errors it raises directly. A create and a
snapshot upsert raise `ShortWriteError`; a versioned update or upsert raises
`VersionConflictError`; a versionless update raises `NoMatchingRowError`. The
error classes are imported from `sdk/errors.ts`, so a repository module
names the type it throws rather than assembling an error with `Object.assign`.
