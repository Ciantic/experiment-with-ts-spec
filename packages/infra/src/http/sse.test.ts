/** Unit tests for the event-stream writable and its heartbeat. See docs/notifications.md. */
import type { ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SSE_HEARTBEAT_MS, SseStream } from "./sse.ts";

/** A `ServerResponse` stand-in, recording every chunk a stream writes and letting a test close it. */
function responseSpy(): { response: ServerResponse; written: string[]; close: () => void } {
    const written: string[] = [];
    const listeners = new Map<string, () => void>();
    const response = {
        writeHead: () => {},
        flushHeaders: () => {},
        write: (chunk: string) => {
            written.push(chunk);
            return true;
        },
        end: () => {},
        destroy: () => {},
        destroyed: false,
        writableEnded: false,
        on: (event: string, listener: () => void) => {
            listeners.set(event, listener);
        },
        off: (event: string, listener: () => void) => {
            if (listeners.get(event) === listener) {
                listeners.delete(event);
            }
        },
    } as unknown as ServerResponse;
    return { response, written, close: () => listeners.get("close")?.() };
}

/** A stream that never yields, so only the heartbeat writes. */
function quiet(signal: AbortSignal): AsyncIterable<unknown> {
    return {
        [Symbol.asyncIterator]: () => ({
            next: () =>
                new Promise<IteratorResult<unknown>>((resolve) => {
                    if (signal.aborted) {
                        resolve({ done: true, value: undefined });
                        return;
                    }
                    signal.addEventListener("abort", () => resolve({ done: true, value: undefined }), { once: true });
                }),
        }),
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe("SseStream", () => {
    it("opens the stream with a comment, so a client's open fires before the first change", async () => {
        const { response, written, close } = responseSpy();
        new SseStream(quiet).writeTo(response);

        expect(written).toEqual([": open\n\n"]);

        close();
    });

    it("writes a comment on a quiet stream, so no proxy drops it for inactivity", async () => {
        vi.useFakeTimers();
        const { response, written, close } = responseSpy();
        new SseStream(quiet).writeTo(response);

        await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
        expect(written).toEqual([": open\n\n", ": ping\n\n"]);

        await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
        expect(written).toEqual([": open\n\n", ": ping\n\n", ": ping\n\n"]);

        close();
        await vi.advanceTimersByTimeAsync(0);
    });

    it("stops the heartbeat once the client closes the stream", async () => {
        vi.useFakeTimers();
        const { response, written, close } = responseSpy();
        new SseStream(quiet).writeTo(response);

        await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
        close();
        await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS * 3);

        expect(written).toEqual([": open\n\n", ": ping\n\n"]);
    });

    it("keeps a comment out of the events, so a heartbeat fires no listener", async () => {
        vi.useFakeTimers();
        const { response, written, close } = responseSpy();
        new SseStream(() =>
            (async function* () {
                yield { op: "INSERT" };
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, SSE_HEARTBEAT_MS * 2);
                });
            })(),
        ).writeTo(response);

        await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS);
        expect(written[0]).toBe(": open\n\n");
        expect(written[1]).toMatch(/^data: /);
        expect(written[2]).toBe(": ping\n\n");

        close();
        await vi.advanceTimersByTimeAsync(SSE_HEARTBEAT_MS * 2);
    });
});
