# Notifications

An entity can publish change events without a row payload. Two read operations
share one Postgres channel:

- `notify` — "something changed on the table", with no payload.
- `watch` — "one of these rows changed", publishing the changed primary key
  and the `TG_OP` that changed it.

They are independent tokens in `@queries` and `@restQueries`:

```ts
/**
 * @pgTable widget
 * @queries query notify watch
 * @restQueries query notify watch
 */
export interface Widget {
    /** @primaryKey */
    id: WidgetId;
}
```

`watch` opts into a row-level trigger that publishes the primary key, because a
listener cannot filter rows it cannot identify. An entity that declares only
`notify` keeps the cheaper statement-level trigger and an empty payload.

- `packages/infra/src/db/queries/notify<Entity>.ts` — generated: all changes.
- `packages/infra/src/db/queries/watch<Entity>.ts` — generated: selected rows.
- `packages/infra/src/db/notifications.ts` — the hand-written subscriptions.
- `packages/infra/src/http/sse.ts` — the stream a generated route answers with.
- `packages/infra/src/postgres/schema.sql` — generated triggers.
- `packages/sdk/src/watch.ts` — the typed `EventSource` helper.

## The triggers

`notify` alone installs a statement-level trigger with no payload:

```sql
create function "widget_notify"() returns trigger as $$
begin
    perform pg_notify('widget', '');
    return null;
end;
$$ language plpgsql;

create trigger "widget_notify" after insert or update or delete on "widget"
    for each statement execute function "widget_notify"();
```

`watch` installs a row-level trigger that publishes only the key. The key values
are canonical text, so a `Date`, a `bigint`, and a `Uint8Array` all compare
deterministically:

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

Declaring both operations installs the row-level trigger, since it serves the
watch; `notify` ignores the key it carries.

## Server side

`notify<Entity>` yields once per change and carries no value:

```ts
for await (const change of notifyWidget(db, { signal })) {
    // re-read the collection
}
```

`watch<Entity>` takes the primary keys and yields the requested key with the
operation that changed it:

```ts
const keys = [{ id: first }, { id: second }];

for await (const { key, op } of watchWidget(db, keys, { signal })) {
    // key is one of the key objects passed in; op is INSERT, UPDATE, or DELETE
}
```

Both release their listening connection when the iterator closes or `signal`
aborts. `subscribe` listens on a connection of its own, so a subscription is not
tied to the executor that made a request, and a write on another connection is
delivered.

Both drivers implement `SqlDriver.listen`: PGlite uses its own listener, and
`PgSqlDriver` checks out a pooled connection for `LISTEN` and returns it after
`UNLISTEN`. An executor whose driver does not listen has no `listen` method, and
the subscription refuses it.

## Over REST

`@restQueries notify` serves `GET /<table>/notify`, with no argument. Each event
is empty:

```
data: 

data: 
```

`@restQueries watch` serves `GET /<table>/watch?q=<keys>`, where `keys` is the
same `<entity>PrimaryKey[]` array the writes use. Each event is
`{ key, op }`, carrying the changed key and the `TG_OP`: `INSERT`, `UPDATE`, or
`DELETE`.

The SDK generates a helper for each:

```ts
import { createHttpClient } from "sdk/index.ts";
import { notifyWidget, watchWidget } from "sdk/api/widget.ts";

const http = createHttpClient("http://127.0.0.1:3000");

const all = notifyWidget(http, () => {
    // any widget changed
});

const one = watchWidget(http, [{ id }], (event) => {
    // event.key.id is the widget; event.op is INSERT, UPDATE, or DELETE
});

// later
all.close();
one.close();
```

The helpers use the platform's `EventSource` by default; pass `options.source`
to supply another implementation, such as a test double. A stream never
finishes, so the group handler refuses a streaming call rather than waiting for
its result.
