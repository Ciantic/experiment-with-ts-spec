/** Unit tests for the typed server-sent event helper. See docs/notifications.md. */
import { stringify } from "devalue";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EventSourceUnavailableError, watch } from "./watch.ts";

/** A stand-in for the browser's `EventSource`, recording what the helper did. */
class FakeSource {
    static instances: FakeSource[] = [];

    readonly url: string;
    onmessage: ((event: { data?: unknown }) => void) | null = null;
    closed = false;

    constructor(url: string) {
        this.url = url;
        FakeSource.instances.push(this);
    }

    close(): void {
        this.closed = true;
    }
}

afterEach(() => {
    FakeSource.instances = [];
    vi.unstubAllGlobals();
});

describe("watch", () => {
    it("opens the URL and decodes each message", () => {
        const changes: string[] = [];
        const subscription = watch<{ id: string }>(
            "http://api.example/widget/watch",
            (key) => changes.push(key.id),
            { source: FakeSource },
        );
        const source = FakeSource.instances[0];

        expect(source?.url).toBe("http://api.example/widget/watch");
        source?.onmessage?.({ data: stringify({ id: "a" }) });
        source?.onmessage?.({ data: stringify({ id: "b" }) });

        expect(changes).toEqual(["a", "b"]);
        subscription.close();
        expect(source?.closed).toBe(true);
    });

    it("passes undefined for an empty event, matching a plain notify stream", () => {
        const seen: unknown[] = [];
        watch("http://api.example/widget/notify", (value) => seen.push(value), {
            source: FakeSource,
        });
        FakeSource.instances[0]?.onmessage?.({ data: "" });

        expect(seen).toEqual([undefined]);
    });

    it("uses the platform's EventSource when none is supplied", () => {
        vi.stubGlobal("EventSource", FakeSource);

        watch("http://api.example/widget/notify", () => {});

        expect(FakeSource.instances[0]?.url).toBe("http://api.example/widget/notify");
    });

    it("refuses a platform with no EventSource", () => {
        vi.stubGlobal("EventSource", undefined);

        expect(() => watch("http://api.example/widget/notify", () => {})).toThrow(
            EventSourceUnavailableError,
        );
    });
});
