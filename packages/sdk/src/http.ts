/**
 * The hand-written half of the client: the transport and the codec.
 * See docs/rest-api.md.
 *
 * Every generated module calls through {@link HttpClient}, so the codec lives in
 * one place. `devalue` round-trips `Date` and `bigint` as themselves, which is
 * why a client call and the server call it reaches share one TypeScript type.
 */
import { parse as decode, stringify as encode } from "devalue";

/** The verbs that carry their argument in the `q` query parameter. */
export type QueryMethod = "GET" | "DELETE";

/** The verbs that carry their argument in the request body. */
export type SendMethod = "POST" | "PATCH";

/** What the generated modules call. */
export interface HttpClient {
    /** Send the argument as the `q` query parameter: the reads and the delete. */
    query<T>(method: QueryMethod, path: string, argument?: unknown): Promise<T>;
    /** Send the argument as the request body: the writes that carry rows. */
    send<T>(method: SendMethod, path: string, body: unknown): Promise<T>;
}

/** A non-2xx response. The body is the server's plain-JSON error. */
export class HttpError extends Error {
    readonly status: number;
    readonly body: unknown;
    /** The tree path of the entry that failed, when the failure came from a group. */
    readonly path: number[] | undefined;

    constructor(status: number, body: unknown) {
        super(`request failed with status ${status}`);
        this.name = "HttpError";
        this.status = status;
        this.body = body;
        this.path = readPath(body);
    }
}

/** The `path` a group failure carries, if the body names one. */
function readPath(body: unknown): number[] | undefined {
    if (typeof body !== "object" || body === null) {
        return undefined;
    }
    const path = (body as { path?: unknown }).path;
    if (!Array.isArray(path) || !path.every((step) => typeof step === "number")) {
        return undefined;
    }
    return path;
}

/** An error body is plain JSON; anything else is kept as text. */
function readError(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/** A client over `baseUrl`, using `fetch` unless another implementation is given. */
export function createHttpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): HttpClient {
    const base = baseUrl.replace(/\/$/, "");

    async function run<T>(method: string, url: string, body: string | undefined): Promise<T> {
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "content-type": "application/json" };
            init.body = body;
        }

        const response = await fetchImpl(url, init);
        const text = await response.text();
        if (!response.ok) {
            throw new HttpError(response.status, readError(text));
        }
        // A void call answers `null`, which the generated signature types as `void`.
        return (text === "" ? undefined : decode(text)) as T;
    }

    return {
        query(method, path, argument) {
            const suffix = argument === undefined ? "" : `?q=${encodeURIComponent(encode(argument))}`;
            return run(method, `${base}${path}${suffix}`, undefined);
        },
        send(method, path, body) {
            return run(method, `${base}${path}`, encode(body));
        },
    };
}
