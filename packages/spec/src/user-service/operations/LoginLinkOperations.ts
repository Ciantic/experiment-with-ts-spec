import type { EmailAddress } from "../../primitives/EmailAddress.ts";
import type { LoginLinkTokenHash } from "../primitives/LoginLinkTokenHash.ts";

export interface LoginLinkOperations<T> {
    /**
     * Mail a one-time sign-in link to the address, if a user exists with that email.
     *
     * @operation
     * @restOperation POST /login-link/request
     * @todo Decide whether an unknown address is answered silently or with an error
     */
    requestLoginLink(ctx: T, opts: {
        email: EmailAddress;
        redirectTo?: string;
    }): Promise<void>;

    /**
     * Login with the one-time sign-in link token.
     *
     * @throws {LoginLinkInvalidError} status=401 when the token is unknown, expired, or already redeemed
     *
     * @operation
     * @restOperation POST /login-link/consume
     * @todo Implement the cookie that carries the session token
     */
    consumeLoginLink(ctx: T, opts: {
        token: LoginLinkTokenHash;
    }): Promise<void>;
}
