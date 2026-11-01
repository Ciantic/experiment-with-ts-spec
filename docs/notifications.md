# Notifications

An entity can publish change events over Postgres `LISTEN`/`NOTIFY`. Two scopes
share one channel:

- `all` — "something changed on the table". A statement-level trigger publishes
  the `TG_OP`; a subscriber receives `{ op }`.
- `rows` — "one of these rows changed". A row-level trigger publishes the
  primary key and `TG_OP`; a subscriber receives `{ pks, op }`.

Declare the scopes with `@notify`, and the subset the REST surface exposes with
`@restNotify`:

```ts
/**
 * @pgTable widget
 * @repository create
 * @queries query
 * @notify all rows
 * @restNotify all rows
 */
export interface Widget {
    /** @primaryKey */
    id: WidgetId;
}
```

`@notify` may name either or both scopes. `@restNotify` is optional and may only
name a scope `@notify` declares, so an entity can stream to backend callers and
stay off the wire. `rows` needs a primary key; a keyless table is already a
diagnostic and gets no row scope.

One generated module serves both scopes:

- `packages/infra/src/db/queries/watch<Entity>.ts` — generated: the change stream.
- `packages/infra/src/db/notifications.ts` — the hand-written subscriptions.
- `packages/infra/src/http/sse.ts` — the stream a generated route answers with.
- `packages/infra/src/postgres/schema.sql` — generated triggers.
- `packages/sdk/src/watch.ts` — the typed `EventSource` helper.

## The triggers

`all` alone installs a statement-level trigger that publishes only `TG_OP`:

```sql
create function "widget_notify"() returns trigger as $$
begin
    perform pg_notify('widget', TG_OP);
    return null;
end;
$$ language plpgsql;

create trigger "widget_notify" after insert or update or delete on "widget"
    for each statement execute function "widget_notify"();
```

`rows` installs a row-level trigger that publishes the operation and the key.
Key values are canonical text, so a `Date`, a `bigint`, and a `Uint8Array`
compare deterministically:

```sql
create function "widget_notify"() returns trigger as $$
begin
    if TG_OP = 'UPDATE' and (OLD."id") is distinct from (NEW."id") then
        perform pg_notify('widget', json_build_object('op', TG_OP, 'key', json_build_object('id', OLD."id"::text))::text);
    end if;
    perform pg_notify('widget', json_build_object('op', TG_OP, 'key', json_build_object('id', coalesce(NEW."id", OLD."id")::text))::text);
    return null;
end;
$$ language plpgsql;

create trigger "widget_notify" after insert or update or delete on "widget"
    for each row execute function "widget_notify"();
```

A key change notifies both the old and the new identity, so a watcher of either
row sees a change. A composite key contributes one JSON field per key column.
Carrying `TG_OP` is one extra field in the same `json_build_object`; it adds no
notification and no query.

Declaring both scopes installs the row-level trigger, since it serves `rows`;
`all` ignores the key it carries. A write that changes several rows therefore
produces one event per row for both scopes, not one event per statement.

## The server-side stream

One `watch<Entity>` function takes the optional `pks`, `ops`, and `signal`:

```ts
watchWidget(db, { ops: ["INSERT"], signal })          // { op } per change
watchWidget(db, { pks, ops: ["UPDATE"], signal })     // { pks, op } per requested row
```

`pks` selects the `rows` scope, so omitting it is the `all` scope. A scope the
annotation does not declare is not offered: `all`-only has no `pks`, and
`rows`-only has no keyless overload.

```ts
for await (const { op } of watchWidget(db, { ops: ["INSERT"], signal })) {
    // a new widget exists
}

for await (const { pks, op } of watchWidget(db, { pks: [{ id }], signal })) {
    // pks is the key object passed in; op is INSERT, UPDATE, or DELETE
}
```

The streams release their listening connection when the iterator closes or
`signal` aborts. `subscribe` listens on a connection of its own, so a
subscription is not tied to the executor that made a request, and a write on
another connection is delivered.

Both drivers implement `SqlDriver.listen`: PGlite uses its own listener, and
`PgSqlDriver` checks out a pooled connection for `LISTEN` and returns it after
`UNLISTEN`. An executor whose driver does not listen has no `listen` method, and
the subscription refuses it.

## Operations

`ops` filters the stream to one or more of `INSERT`, `UPDATE`, and `DELETE`.
Omitted means every operation; an empty array means none.

The filter runs in the subscription: the trigger publishes every operation on
the table's one channel, and the generated stream discards the ones the caller
did not name. For a table with heavy update traffic this still wakes the
listener for every change; per-operation channels are the next step if that
becomes measurable.

## Over REST

`@restNotify all` serves `GET /<table>/watch?q=<{ ops? }>`. Each event is
`{ op }`:

```
data: {"op":"INSERT"}

```

`@restNotify rows` serves `GET /<table>/watch?q=<{ pks, ops? }>`, where `pks` is
the same `<entity>PrimaryKey[]` array the writes use. Each event is
`{ pks, op }`, carrying the requested key and the `TG_OP`.

With both scopes exposed, `pks` is optional: omit it for the table stream, or
send it for the row stream. With only `rows`, the route rejects a call without
`pks`; with only `all`, it rejects one with `pks`.

The SDK generates one helper, with an overload per exposed scope:

```ts
import { createHttpClient } from "sdk/index.ts";
import { watchWidget } from "sdk/api/widget.ts";

const http = createHttpClient("http://127.0.0.1:3000");

const all = watchWidget(http, (event) => {
    // event.op is INSERT, UPDATE, or DELETE
}, { ops: ["DELETE"] });

const one = watchWidget(http, (event) => {
    // event.pks.id is the widget; event.op is INSERT, UPDATE, or DELETE
}, { pks: [{ id }], ops: ["UPDATE"] });

// later
all.close();
one.close();
```

The helper uses the platform's `EventSource` by default; pass `options.source`
to supply another implementation, such as a test double. A stream never
finishes, so the group handler refuses a streaming call rather than waiting for
its result.
