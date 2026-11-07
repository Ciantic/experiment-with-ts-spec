/** Loopback ports the playground probes: whether one answers, and a free one to hand to a child process. */
import { createConnection, createServer } from "node:net";

/** Whether anything accepts a connection on the loopback port. */
export async function acceptsConnections(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

/** A loopback port nothing listens on, released by the probe before it is answered. */
export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            const port = typeof address === "object" && address !== null ? address.port : 0;
            probe.close(() => resolve(port));
        });
    });
}
