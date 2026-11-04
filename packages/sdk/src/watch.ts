/** The typed server-sent event helper behind every generated `watch<Entity>`. See docs/notifications.md. */
import { parse as decode } from "devalue";

/** The statement that changed a watched row. */
export type WatchOperation = "INSERT" | "UPDATE" | "DELETE";

/** One watched change: the requested key, and what happened to it. */
export interface WatchRowsEvent<Key> {
    pks: Key;
    op: WatchOperation;
}

/** The values a change stream matches: the fields an entity declares with `@watchFilter`, compared for equality. See docs/notifications.md. */
export type WatchFilter<E, K extends keyof E = keyof E> = Partial<Pick<E, K>>;

/** An all-rows change: the operation, without a key. */
export interface WatchAllEvent {
    op: WatchOperation;
}

/** Open a server-sent event stream and call `onChange` for each decoded event. */
export function watch<T = void>(
    url: string,
    onChange: (value: T) => void,
): EventSource {
    const source = new EventSource(url);
    source.onmessage = (event) => {
        const data = event?.data;
        onChange((typeof data === "string" && data !== "" ? decode(data) : undefined) as T);
    };
    return source;
}
