/** The hand-written transport and codec; every generated module calls through {@link HttpClient}. See docs/rest-api.md. */
import { parse as decode, stringify as encode } from "devalue";
import { AppError, apiErrorFromBody } from "./errors.ts";

export * from "./errors.ts";

/** The verbs that carry their argument in the `q` query parameter. */
export type QueryMethod = "GET" | "DELETE";

/** The verbs that carry their argument in the request body. */
export type SendMethod = "POST" | "PUT" | "PATCH";

/** What the generated modules call. */
export interface HttpClient {
    /** The root every path is appended to, so a generated long-lived helper can build its own URL. */
    readonly baseUrl: string;
    /** The URL a call with its argument in `q` would use; an `EventSource` takes a URL rather than a call. */
    url(path: string, argument?: unknown): string;
    /**
     * Send the argument as the `q` query parameter: the reads and the delete.
     * @throws {AppError} the error class the response names, or `HttpError` when it names none
     */
    query<T>(method: QueryMethod, path: string, argument?: unknown): Promise<T>;
    /**
     * Send the argument as the request body: the writes that carry rows.
     * @throws {AppError} the error class the response names, or `HttpError` when it names none
     */
    send<T>(method: SendMethod, path: string, body: unknown): Promise<T>;
}

/** A non-2xx response this client cannot classify; the body is the server's plain-JSON error. */
export class HttpError extends AppError {
    readonly body: unknown;

    constructor(status: number, body: unknown) {
        const path = readPath(body);
        super(
            `request failed with status ${status}`,
            { kind: "http", status },
            path === undefined ? {} : { path },
        );
        this.body = body;
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

/**
 * A client over `baseUrl`, using `fetch` unless another implementation is given.
 * @throws {AppError} the error class the response names, or `HttpError` when it names none
 */
export function createHttpClient(baseUrl: string, fetchImpl: typeof fetch = fetch): HttpClient {
    const base = baseUrl.replace(/\/$/, "");
    const urlFor = (path: string, argument?: unknown): string =>
        argument === undefined
            ? `${base}${path}`
            : `${base}${path}?q=${encodeURIComponent(encode(argument))}`;

    /**
     * Send one request and decode its answer, raising the error the body names.
     * @throws {AppError} the error class the response names, or `HttpError` when it names none
     */
    async function run<T>(method: string, url: string, body: string | undefined): Promise<T> {
        const init: RequestInit = { method };
        if (body !== undefined) {
            init.headers = { "content-type": "application/json" };
            init.body = body;
        }

        const response = await fetchImpl(url, init);
        const text = await response.text();
        if (!response.ok) {
            const failure = readError(text);
            throw apiErrorFromBody(response.status, failure) ?? new HttpError(response.status, failure);
        }
        // A void call answers `null`, which the generated signature types as `void`.
        return (text === "" ? undefined : decode(text)) as T;
    }

    return {
        baseUrl: base,
        url: urlFor,
        query(method, path, argument) {
            return run(method, urlFor(path, argument), undefined);
        },
        send(method, path, body) {
            return run(method, `${base}${path}`, encode(body));
        },
    };
}
