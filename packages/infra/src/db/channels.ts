/** One driver connection per channel, fanned out to every subscriber of it. See docs/notifications.md. */
import type { SqlSubscription } from "./sql-executor.ts";

/** A driver's raw listen: open one connection on `channel` and report every payload it carries. */
export type OpenChannel = (
    channel: string,
    onNotification: (payload: string) => void,
) => Promise<SqlSubscription>;

/** One subscription's callback, kept as an object so the same function may subscribe twice. */
interface Subscriber {
    readonly notify: (payload: string) => void;
}

/** An open channel: the driver's connection, the subscribers it delivers to, and whether it has been released. */
interface Channel {
    readonly subscribers: Set<Subscriber>;
    readonly subscription: Promise<SqlSubscription>;
    closed: boolean;
}

/** The connection a channel is listened on, opened once however many subscriptions the channel carries. */
export class ChannelListeners {
    readonly #open: OpenChannel;
    readonly #channels = new Map<string, Channel>();

    constructor(open: OpenChannel) {
        this.#open = open;
    }

    /**
     * Join `channel`, opening its connection when this is the channel's first subscriber.
     * @throws when the driver cannot listen, as its `open` reports it
     */
    async subscribe(channel: string, onNotification: (payload: string) => void): Promise<SqlSubscription> {
        const entry = this.#channels.get(channel) ?? this.#openChannel(channel);
        const subscriber: Subscriber = { notify: onNotification };
        entry.subscribers.add(subscriber);
        try {
            await entry.subscription;
        } catch (thrown) {
            entry.subscribers.delete(subscriber);
            throw thrown;
        }
        let closed = false;
        return {
            close: async () => {
                if (closed) {
                    return;
                }
                closed = true;
                entry.subscribers.delete(subscriber);
                if (entry.subscribers.size > 0) {
                    return;
                }
                // The channel leaves the map first, so a subscriber arriving now opens a connection of its own.
                if (this.#channels.get(channel) === entry) {
                    this.#channels.delete(channel);
                }
                await this.#close(entry);
            },
        };
    }

    /** Close every channel's connection, for a driver that is shutting down. */
    async closeAll(): Promise<void> {
        const entries = [...this.#channels.values()];
        this.#channels.clear();
        for (const entry of entries) {
            await this.#close(entry);
        }
    }

    /** Open a channel's connection and register it, so a concurrent subscriber joins rather than opens. */
    #openChannel(channel: string): Channel {
        const subscribers = new Set<Subscriber>();
        const subscription = this.#open(channel, (payload) => {
            for (const subscriber of subscribers) {
                try {
                    subscriber.notify(payload);
                } catch {
                    // One subscriber's failure is not the others', and it must not reach the driver.
                }
            }
        });
        const entry: Channel = { subscribers, subscription, closed: false };
        this.#channels.set(channel, entry);
        // A channel that failed to open is not one to join, so its next subscriber asks the driver again.
        void subscription.catch(() => {
            if (this.#channels.get(channel) === entry) {
                this.#channels.delete(channel);
            }
        });
        return entry;
    }

    /** Release a channel once; a failed `unlisten` is not a failure the channel's subscribers can act on. */
    async #close(entry: Channel): Promise<void> {
        if (entry.closed) {
            return;
        }
        entry.closed = true;
        entry.subscribers.clear();
        try {
            await (await entry.subscription).close();
        } catch {
            // The driver releases the connection whether or not its `unlisten` ran.
        }
    }
}
