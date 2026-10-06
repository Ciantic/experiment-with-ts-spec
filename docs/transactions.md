# Transactions

A repository function takes `db: SqlExecutor`, and a create or a delete returns
after one statement. A patch or an upsert of several rows is one statement per
chunk, so the repository opens a boundary itself and the chunks commit together; a
single row is one atomic statement and runs on the handle it was given. Anything
spanning two *calls* still belongs to the caller (`docs/repositories.md`, "No
transaction wrapping"). This note records the port that lets a caller own that
unit, and the two places a boundary is opened over REST: inside a handler that
owns its own sequence, and around a group of calls a client composes into one
request.

Two places exist because a boundary is asked for by two different parties. A
handler asks for one when the server authored the sequence, such as issuing and
delivering an invoice. A group asks for one when the caller composed the
sequence, such as an editor saving a header and its rows in one request.

Atomicity and batching are separate axes, and the SDK keeps them separate:
`transaction` is the only client-facing construct that opens one, and `batch`
only says the calls travel in one request. A batch of two writes that fails on
the second has written the first; wrapping it in `transaction` is what makes it
all-or-nothing.

## The port

`SqlExecutor` is the whole database surface: a statement, and the unit of work a
caller can run statements in.

```ts
export interface SqlExecutor {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    transaction<T>(run: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** One session borrowed from a pool; `release` returns it. */
export interface SqlSession {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    release(): void;
}

/** The whole surface a boundary is built on: statements, and a checkout that pins one session to it. */
export interface SqlPool {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
    connect(): Promise<SqlSession>;
}
```

`SqlPool` is structural rather than a named driver, so a `pg` `Pool` satisfies it
as it stands and the port names no driver: `createPgPool`
(`src/postgres/pg-setup.ts`) is a `pg` pool with the spec's result mapping
applied. A one-connection driver reaches it through
`createSingleConnectionPool` (`src/db/sql-pool.ts`), which serialises its one
session; `createPglitePool` (`src/postgres/pglite-setup.ts`) is PGlite over it.

`query` returns `unknown` because the result is the driver's. Two readers
(`src/db/sql-executor.ts`) take the two shapes out of it: `resultRows` answers
the `rows` array both drivers carry, which the result mapping and a generated
patch both read, and `affectedRows` answers the count from whichever name the
driver used — `affectedRows` on PGlite, `rowCount` on `pg`. A result that
carries neither is a driver the port does not know, so the reader throws rather
than answering no rows or `0`, which would read as a statement that matched
nothing. A generated patch or upsert reads the rows it wrote to reject a chunk
that wrote fewer (`docs/versioning.md`).

`createTransactionalDb` (`src/db/sql-executor.ts`) is the one implementation,
over a pool:

- **A checkout pins the session, and that is what the boundary rests on.** A `pg`
  pool hands out a `PoolClient`, so `begin`…`commit` covers exactly the
  statements that run on it; PGlite has one connection, so its pool holds that
  connection until the checkout releases it.
- **The port issues the root boundary** — `begin`, `commit`, or `rollback` on the
  checked-out session — and releases the session in a `finally`.
- **A nested boundary is a savepoint** on the same session, so one set of
  boundary statements is what both drivers run.

The generated repositories and queries take `SqlExecutor`, so a caller passes the
handle it already has. A repository opens a boundary only where its own call is
more than one statement — a patch of several rows — and otherwise leaves the unit
of work to the caller, which is what keeps a request's atomicity in one place
(`docs/repositories.md`).

Affinity is scoped to the boundary, not to the handle. `SqlExecutor` is a pool
handle, not a session handle: a `query` on the root handle borrows a session for
that statement and releases it, so two of them may run on different connections.
Every statement inside a `transaction` callback, its savepoints included, runs on
the one session that boundary checked out. Session-scoped state — a temp table,
`set local`, an advisory lock, a prepared statement — is therefore only coherent
inside a boundary, and a caller that needs it opens one.

A statement must go through the handle it was given. The pool is not the boundary:
a `query` made on the pool while a checkout is open waits for the one connection,
and on `pg` it would land on another connection and escape the transaction.

The router opens one boundary per `transaction` group it meets while walking a
request, and hands every handler the `SqlExecutor` of the boundary it is in. A nested
group does not join the outer one — it opens a savepoint inside it, so it can
roll back on its own while the outer boundary still commits. Two sibling
`transaction` groups are two boundaries, atomic separately, inside one request.

The router does not decide that itself. `db/group.ts` holds the three boundary
semantics over the port, and the router only maps a group's `kind` onto one of
them. The names are the SDK's, so the same vocabulary names the same boundaries
on both sides:

```ts
export type Step = (db: SqlExecutor) => Promise<unknown>;
export type Attempted<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: unknown };

export function batch<const T extends readonly Step[]>(db: SqlExecutor, ...steps: T): Promise<Results<T>>;
export function transaction<const T extends readonly Step[]>(db: SqlExecutor, ...steps: T): Promise<Results<T>>;
export function attempt<const T extends readonly Step[]>(db: SqlExecutor, ...steps: T): Promise<Attempted<Results<T>>>;
```

A step is one unit of work that is handed the `SqlExecutor` it must run on, so the three
differ in exactly two ways: whether the steps share a boundary, and whether a
step's failure is raised or reported. Unlike a call tree, which is heterogeneous
by construction and reaches `devalue` as `unknown[]`, a hand-written group is a
variadic tuple, so `Results<T>` keeps each step's own result:

```ts
const [found, written] = await transaction(
    db,
    (tx) => queryInvoice(tx, { select: { id: true } }),
    async (tx) => {
        await createInvoice(tx, [invoice]);
    },
);
// found: Selected<Invoice, { id: true }>[]; written: void
```

`attempt` reports the error unchanged rather than interpreting it, because what a
failure means — its path, its HTTP status, whether it was even this group's to
tolerate — is a router question.

That split is what makes the semantics testable without a spec.
`src/db/group.test.ts` drives the three against a real PGlite over a `widget`
table it creates itself, so it asserts the boundary behaviour — that a failed
`transaction` leaves nothing behind, that a nested one is a savepoint the outer
transaction survives — without naming a domain type or a route. The load-bearing
property it can assert and a mock cannot is that the steps really do receive the
boundary handle: were `transaction` to hand its steps the outer `db`, the rows
would survive the rollback and the assertion would fail.

## Who owns the boundary

A handler owns its boundary. It receives a `SqlExecutor` scoped to the request, and it
opens a unit of work when it needs one:

```ts
export interface Route {
    method: HttpMethod;
    path: string;
    source: "query" | "body";
    input: RouteInput;
    handler: (db: SqlExecutor, argument: unknown) => Promise<unknown>;
}
```

```ts
export function sendInvoice(db: SqlExecutor, opts: SendInvoiceOptions): Promise<void> {
    return db.transaction(async (tx) => { … });
}
```

There is no per-route flag saying "run this in a transaction", because such a flag
would say nothing a handler cannot: any handler that needs a boundary opens one.
What the flag would have had to carry is the composition rule, and that belongs
to the scope, not the route.

### A nested boundary is a savepoint

Nesting is real: the handle a `transaction` callback receives is a `SqlExecutor`
as well, and its `transaction` opens a savepoint rather than a second
transaction.

```ts
export function createTransactionalDb(pool: SqlPool): SqlExecutor {
    let savepoints = 0;
    async function savepoint<T>(session: SqlSession, run: (tx: SqlExecutor) => Promise<T>): Promise<T> {
        const name = `sp_${(savepoints += 1)}`;
        await session.query(`savepoint ${name}`);
        try {
            const value = await run(handle(session));
            await session.query(`release savepoint ${name}`);
            return value;
        } catch (thrown) {
            await session.query(`rollback to savepoint ${name}`);
            await session.query(`release savepoint ${name}`);
            throw thrown;
        }
    }
    return {
        query: (sql, parameters) => pool.query(sql, parameters),
        transaction: async (run) => {
            const session = await pool.connect();
            try {
                await session.query("begin");
                const value = await run(handle(session));
                await session.query("commit");
                return value;
            } catch (thrown) {
                await session.query("rollback");
                throw thrown;
            } finally {
                session.release();
            }
        },
    };
}
```

So the same handler behaves correctly wherever it is called:

| Called | Its `db.transaction` |
| --- | --- |
| on its own route | opens one, because nothing is ambient |
| inside a client's `transaction` group | opens a savepoint inside it |
| inside a `batch` group | opens one, because a batch has none |

A handler never needs to know whether its caller already asked for a unit of
work. A per-entity CRUD route asks for nothing: `delete` is one multi-row
statement, and a patch or an upsert of one row is one statement, so each is
already atomic, and a boundary around it would add a round trip and a held
connection without changing what a concurrent writer can observe. A patch or an
upsert of several rows — and a create whose rows spill past the statement's
parameter limit — open their own boundary, which nests as a savepoint inside one
the caller already holds.

The root boundary is the port's own `begin`/`commit`, issued on the session the
pool checked out. What makes that safe is the checkout, not the statement: a `pg`
`PoolClient` pins one connection, and the one-connection pool holds PGlite's
single connection until the boundary releases it. A hand-issued `begin` on a pool
that did not pin its session would let another request's statement run inside the
open boundary and be rolled back with it, which is exactly what a checkout
prevents.

`rollback to savepoint` is load-bearing, not tidiness. An error aborts the whole
transaction — every later statement fails with `25P02` — so rolling back to the
savepoint is the only thing that makes the outer boundary usable again. Without
it, a nested failure would poison everything after it rather than just its own
subtree.

### Named operations

A boundary is worth asking for where one request is more than one repository
call. `sendInvoice` is the case: it reads the draft, writes `invoice_sent` and
`invoice_sent_row`, freezes the parties, and delivers.

Nothing marks it as such. The implementation is hand-written, takes `SqlExecutor`, and
opens the boundary itself — `transaction(db, …)` where it wants a unit of work,
`attempt(db, …)` where a step may fail without taking the rest down — which is
what makes it callable outside the router too: a seed script or a test passes any
`SqlExecutor` and the same function works. No route is a named operation yet, because
`InvoiceOperations` is still a contract with no implementation
(`docs/invoice-sending.md`); `Route.handler` taking `SqlExecutor` is the seam it lands on.

A client composes its own boundary with a group instead, which is the subject of
the rest of this note. The distinction is who authored the sequence, not what the
database does: the server owns the boundary of a sequence it wrote, and the
caller owns the boundary of a sequence it composed.

## The SDK face

The generated client builds calls; it does not make them. A builder is plain
data, and `exec` is the only thing that reaches the network:

```ts
export interface Call<R> {
    readonly kind: "call";
    readonly method: Method;
    readonly path: string;
    readonly argument: unknown;
    readonly [Result]?: R;
}

export interface Group<R> {
    readonly kind: "batch" | "transaction" | "attempt";
    readonly calls: readonly Executable[];
    readonly [Result]?: R;
}

export type Attempted<R> =
    | { readonly ok: true; readonly value: R }
    | { readonly ok: false; readonly error: { readonly message: string; readonly path: number[] } };

export type Executable<R = unknown> = Call<R> | Group<R>;
```

The generator emits the builders, one per exposed call. Everything above, plus
`exec`, `transaction`, `attempt`, `batch`, and `bundle`, is hand-written in
`sdk/src/client.ts` next to the transport in `sdk/src/http.ts` — the same split as
the server, where the router is hand-written and the route table is generated.
The SDK declares its own `Method` union rather than importing the router's, so
the client still imports nothing from the backend.

Every generated function takes its domain argument and returns a `Call`, never
a `Promise`, and never an `HttpClient`:

```ts
export function createInvoice(rows: InvoiceInsert[]): Call<void>
export function queryInvoice<S extends Selection<Invoice>>(opts: { …; select: S }): Call<Selected<Invoice, S>[]>
```

```ts
await exec(http, createInvoice(rows));
const [invoice] = await exec(http, queryInvoice({ filter: { id: [id] }, select: { number: true } }));
```

The `http` argument moves from every call to `exec`, and that is what makes a
call composable: a builder with a client already bound could not be handed to
`transaction` or `batch`. It also keeps the `Selected<E, S>` narrowing, because
`S` is fixed when the builder is called rather than when it is sent.

`transaction`, `attempt`, and `batch` take builders and return a group, so the
axes compose in either direction:

```ts
await exec(http, transaction(createInvoice(rows), createInvoiceRow(rowInserts)));
await exec(http, batch(queryInvoice(a), transaction(createInvoice(rows), createInvoiceRow(rowInserts))));
await exec(http, transaction(createInvoice(rows), attempt(createInvoiceRow(bad))));
```

A group's result is a tuple aligned with its arguments, and nesting composes:

| Call | Result |
| --- | --- |
| `exec(http, createInvoice(rows))` | `Promise<void>` |
| `exec(http, transaction(writeA, writeB))` | `Promise<void>` — an all-void group collapses to `void` |
| `exec(http, batch(read, writeA))` | `Promise<[Row[], void]>` |
| `exec(http, transaction(batch(readA, readB), write))` | `Promise<[[RowA[], RowB[]], void]>` |
| `exec(http, attempt(read, writeA))` | `Promise<Attempted<[Row[], void]>>` |

An all-void group collapses to `void`, which is why the rejected branch of an
`attempt` over writes is `Attempted<void>` rather than a tuple of nothings.

A named form maps the same values onto keys, for a group long enough that
positions stop being readable:

```ts
const { found, written } = await exec(http, bundle({
    found: queryInvoice({ select: { number: true } }),
    written: createInvoice(rows),
}));
```

A builder is immutable data, so one may be passed to two groups. It is not
thenable, so `await createInvoice(rows)` compiles and does nothing; `exec` is the
only way a call is made.

## The group endpoint

A group is one `POST /$group` whose body is a tree:

```ts
type Wire = { call: { method: HttpMethod; path: string; argument: unknown } }
          | { group: { kind: "batch" | "transaction" | "attempt"; calls: Wire[] } };
```

The router resolves every `call` against the same route table it matches a single
request on, and validates the entry with that route's `input`. The `source` field
is not consulted: a single request reads `q` or the body, but an entry already
carries its argument as a field.

**The whole tree is validated before any of it executes**, so a malformed group
is a 400 that has written nothing. Only a runtime failure can leave a partial
trace, and that is the case `transaction` exists for.

The `kind` decides the database boundary, and nothing else does:

| Property | `batch` | `transaction` | `attempt` |
| --- | --- | --- | --- |
| Order | tree order, sequentially, depth first | same | same |
| Boundary | none — each statement commits on its own | one, all or nothing | one, all or nothing |
| Reads | each read is its own snapshot | one snapshot for the group | one snapshot for the group |
| On failure | stops; earlier writes stand | stops; the group is rolled back | reports the failure, keeps the result |

So a `batch` of writes is a round-trip saving, not a unit of work: a failure on
the third entry leaves the first two committed. `transaction` is what makes a
group atomic, and `attempt` is a `transaction` that survives its own failure.

Nested in a `transaction`, a `transaction` group opens a savepoint and an
`attempt` group does too — which is what lets one entry fail without taking the
rest of the request with it:

```ts
await exec(client, transaction(
    createCustomer([survivor]),
    attempt(createCustomer([victim]), createInvoice([orphan])),   // fails on the foreign key
    createCustomer([patient]),
));
// the survivor and patient commit; the victim's group is rolled back to its savepoint
// [null, { ok: false, error: { message: …, path: [1, 1] } }, null]
```

An `attempt` reports rather than raises, so it answers a marker instead of a
value:

| Outcome | Result |
| --- | --- |
| succeeded | `{ ok: true, value: <the group's results> }` |
| failed | `{ ok: false, error: { message, path } }` |

`path` is absolute from the request root, the same coordinate a group failure
uses, so a caller can name the entry that failed without walking the tree it
sent. Only a failure inside the `attempt`'s own subtree is tolerated; anything
else propagates, so an outer failure is never mistaken for a tolerated one.

Resolution through the route table is what keeps this from becoming a second
surface. Every call a group can make is a call that already exists, and a check
added to a single route — validation, and later an authorization guard — runs for
its entry too, because the entry goes through the route.

Where the argument travels follows from a group being a write: the calls are in a
body, so a batched read escapes the `q` length limit that `docs/rest-api.md`
records, and the 1 MB body cap is the only size bound besides a cap on the number
of entries.

A failed group names the entry that failed by its path in the tree:

```json
{ "error": "version conflict on invoice 3f…", "path": [2, 1] }
```

That is what makes a retry tractable. The client holds the tree it sent, so it can
name the entry from the path. A version conflict aborts the transaction it is in
(`docs/versioning.md`), so the client re-reads the rows it needs and resends those
calls; nothing in that transaction was written, though an earlier `batch` sibling
that already ran stands. A sequence of separate calls has no such story — the
caller cannot know which of the earlier writes landed.

The wire shape is exactly the value the SDK already holds, so nothing encodes a
call twice: `toWire` in `sdk/src/client.ts` walks the group into the tree the
router reads, and `devalue` carries it as the body. As with a single call, the
client imports nothing from the backend.

## Gotchas

- **A `batch` is not a unit of work.** Two writes in a `batch` commit
  separately, so a failure on the second leaves the first committed. Wrap the
  group in `transaction` when the caller needs both or neither.
- **A read in a `batch` is its own snapshot.** For several reads that must agree
  with each other — a parent and its children — use `transaction`, which is the
  only construct that gives a group one snapshot (`docs/queries.md` records the
  read it closes).
- **`now()` is transaction time.** Every row a `transaction` writes shares
  `createdAt` and `updatedAt` (`docs/timestamps.md`). Two savepoints in one
  request therefore produce identical timestamps, and a nested boundary does not
  get a clock of its own.
- **A version conflict aborts its transaction.** One stale version rolls back
  every entry of the group it is in, up to the nearest enclosing boundary. A patch
  whose statement wrote fewer rows than it carried counts the same way, since it
  is the same `40001`. The caller resends after re-reading, or wraps the entry in
  an `attempt` to keep the rest of the group.
- **A transaction holds one connection and its locks.** A long group reduces the
  pool available to other requests and holds row locks for its duration, so the
  entry cap and a statement timeout are the backstops. A nested boundary adds a
  `savepoint` and a `release` round trip; a failed one adds a `rollback to
  savepoint`.
- **A builder is inert.** `await createInvoice(rows)` compiles and does nothing,
  because a builder is not thenable. `exec` is the only function that makes a
  call, and the generated modules take no `HttpClient`.
- **Both sides declare the group contract.** `GROUP_PATH` and the verb list are
  written twice, in `sdk/src/client.ts` and in `src/http/router.ts`, because the
  client may not import the backend. No generated artifact keeps them in step, so
  the end-to-end test is what does: a group is the only call whose path is not
  derived from `rest-model.ts`.
- **Writes answer `null`.** A group follows the single-call codec rule that a
  void write encodes as `null`; the generated signature types it `void`.
- **An all-void group has no tuple.** `transaction(writeA, writeB)` resolves to
  `void`, not `[void, void]`, so it cannot be destructured — the collapse that
  makes `const done = await exec(…)` read well is what removes the positions.
- **A tolerated failure is a result, not an error.** An `attempt` answers 200
  with `ok: false`, so a caller that ignores the marker has silently lost the
  write it asked for.
- **A patch clears a nullable column with `null`.** Omitting the field keeps the
  stored value and `null` writes a null, so a group entry can clear one like any
  other write. A non-nullable column rejects the null at the database
  (`docs/repositories.md`).
- **A group reaches the whole surface in one request.** An entry may be any
  route, so whatever a single unauthenticated request can do, a group can do in
  one call. Serial execution bounds it; it does not scope it.
- **The seed has no transaction.** The mock data is written call by call
  (`docs/mockdata.md`); wrapping it is a use of `SqlExecutor`, not part of this surface.
- **The backend keeps its tuples.** A hand-written `transaction(db, writeA, writeB)`
  answers `[void, void]`; only the SDK's all-void group collapses to `void`. The
  positions are what a caller destructures, so `db/group.ts` keeps them and casts
  once, at the one place the variadic spread loses the pairing of a step to its
  result.
- **Savepoint names are per-`SqlExecutor`, not per-transaction.** `createTransactionalDb`
  counts up for the process's lifetime, so the names are unique within a boundary
  without any coordination. If the counter ever had to wrap it would reuse a
  name inside a live transaction, which is why it does not.

## Deliberately not implemented

- **A boundary that commits independently of its outer one.** A nested
  `transaction` is a savepoint, so it can roll back on its own but its writes live
  and die with the outer boundary. Committing half a request's writes is not
  possible without an autonomous transaction, which Postgres only offers through
  an extension.
- **Authorization.** A group runs each entry through its route, so a guard on
  the route would apply per entry, but no guard exists yet
  (`docs/rest-api.md`, "Deliberately not implemented").
- **A route that refuses to run inside a caller's boundary.** A handler that asks
  for a boundary gets a savepoint when one is ambient, and any route may be a
  group entry, so a caller can pull a call into its transaction. That is right
  for a sequence of writes and wrong for one with a side effect a rollback cannot
  undo — delivery is the case (`docs/invoice-sending.md`). Declaring that needs
  an operation to exist first.
- **Choosing an isolation level or a retry policy.** A transaction runs at the
  session default; recognising a conflict and retrying is the caller's decision.
- **A transaction spanning requests.** A client that needs one sends a
  `transaction` group; there is no session, no prepared transaction, and no
  two-phase commit.
- **Streaming inside a transaction.** A group resolves with all results before
  the commit, so a large read is materialised rather than streamed.
- **A group sent anywhere but the group route.** A generated call list posted to
  an entity path is not a group and opens no transaction.
