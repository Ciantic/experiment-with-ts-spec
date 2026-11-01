/** Checks the fan-out that gives a channel one driver connection however many subscribers it has. See docs/notifications.md. */
import { describe, expect, it } from "vitest";
import { ChannelListeners, type OpenChannel } from "./channels.ts";

/** A connection a fake driver opened: its channel, the callback it reports to, and how often it was released. */
interface Connection {
    channel: string;
    notify: (payload: string) => void;
    closes: number;
}

/** A driver's `open` that records every connection it was asked for. */
function fakeDriver(): { open: OpenChannel; connections: Connection[] } {
    const connections: Connection[] = [];
    const open: OpenChannel = (channel, onNotification) => {
        const record: Connection = { channel, notify: onNotification, closes: 0 };
        connections.push(record);
        return Promise.resolve({
            close: async () => {
                record.closes += 1;
            },
        });
    };
    return { open, connections };
}

describe("ChannelListeners", () => {
    it("opens one connection for every subscriber of a channel", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);
        const seen: string[] = [];

        await registry.subscribe("widget", (payload) => seen.push(`first:${payload}`));
        await registry.subscribe("widget", (payload) => seen.push(`second:${payload}`));
        connections[0]?.notify("changed");

        expect(connections).toHaveLength(1);
        expect(seen).toEqual(["first:changed", "second:changed"]);
    });

    it("opens one connection per channel", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);
        const seen: string[] = [];

        await registry.subscribe("widget", (payload) => seen.push(`widget:${payload}`));
        await registry.subscribe("account", (payload) => seen.push(`account:${payload}`));
        connections[1]?.notify("changed");

        expect(connections.map((connection) => connection.channel)).toEqual(["widget", "account"]);
        expect(seen).toEqual(["account:changed"]);
    });

    it("keeps a connection open until its last subscriber closes", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);
        const seen: string[] = [];

        const first = await registry.subscribe("widget", (payload) => seen.push(`first:${payload}`));
        const second = await registry.subscribe("widget", (payload) => seen.push(`second:${payload}`));
        await first.close();
        connections[0]?.notify("changed");

        expect(connections[0]?.closes).toBe(0);
        expect(seen).toEqual(["second:changed"]);

        await second.close();
        expect(connections[0]?.closes).toBe(1);
    });

    it("reopens a channel for a subscriber that arrives after the last one closed", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);
        const seen: string[] = [];

        const first = await registry.subscribe("widget", (payload) => seen.push(`first:${payload}`));
        await first.close();
        await registry.subscribe("widget", (payload) => seen.push(`second:${payload}`));
        connections[1]?.notify("changed");

        expect(connections).toHaveLength(2);
        expect(seen).toEqual(["second:changed"]);
    });

    it("rejects every subscriber of a channel that failed to open, and asks the driver again for the next", async () => {
        let attempts = 0;
        const registry = new ChannelListeners(async () => {
            attempts += 1;
            if (attempts === 1) {
                throw new Error("cannot listen");
            }
            return { close: async () => {} };
        });

        const rejected = await Promise.allSettled([
            registry.subscribe("widget", () => {}),
            registry.subscribe("widget", () => {}),
        ]);
        await expect(registry.subscribe("widget", () => {})).resolves.toBeTypeOf("object");

        expect(rejected.map((result) => result.status)).toEqual(["rejected", "rejected"]);
        expect(attempts).toBe(2);
    });

    it("delivers to the other subscribers when one of them throws", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);
        const seen: string[] = [];

        await registry.subscribe("widget", () => {
            throw new Error("subscriber boom");
        });
        await registry.subscribe("widget", (payload) => seen.push(payload));
        connections[0]?.notify("changed");

        expect(seen).toEqual(["changed"]);
    });

    it("keeps two subscriptions of the same callback apart", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);
        let calls = 0;
        const onNotification = () => {
            calls += 1;
        };

        const first = await registry.subscribe("widget", onNotification);
        const second = await registry.subscribe("widget", onNotification);
        connections[0]?.notify("changed");
        expect(calls).toBe(2);

        await first.close();
        connections[0]?.notify("changed");
        expect(calls).toBe(3);
        expect(connections[0]?.closes).toBe(0);

        await second.close();
        expect(connections[0]?.closes).toBe(1);
    });

    it("releases a connection that finishes opening after shutdown began", async () => {
        let finish!: () => void;
        const gate = new Promise<void>((resolve) => {
            finish = resolve;
        });
        let closes = 0;
        const registry = new ChannelListeners(async () => {
            await gate;
            return {
                close: async () => {
                    closes += 1;
                },
            };
        });

        const joining = registry.subscribe("widget", () => {});
        const closing = registry.closeAll();
        finish();
        await closing;
        const subscription = await joining;
        await subscription.close();

        expect(closes).toBe(1);
    });

    it("releases a channel that is closed by a subscriber and by shutdown only once", async () => {
        const { open, connections } = fakeDriver();
        const registry = new ChannelListeners(open);

        const subscription = await registry.subscribe("widget", () => {});
        await registry.closeAll();
        await subscription.close();

        expect(connections[0]?.closes).toBe(1);
    });
});
