import type { EmailAddress } from "../../primitives/EmailAddress.ts";
import type { LoginLinkChallenge } from "../LoginLinkChallenge.ts";

export interface LoginLinkOperations<T> {
    /**
     * Create a one-time sign-in token, storing only its hash.
     *
     * @operation
     * @testDescribe Login-link token creation
     * @testIt Creates a one-time token
     * @testIt Stores only the token's hash
     * @testIt Expires the token
     * @testIt Calls createEmailVerificationToken for the address
     * @todo Implement 
     */
    createLoginLinkToken(ctx: T, opts: {
        email: EmailAddress;
    }): Promise<LoginLinkChallenge>;

    /**
     * Mail a one-time sign-in link to the address, if a user exists with that email.
     *
     * @operation
     * @restOperation POST /login-link/request
     * @restPublic
     * @testDescribe Login-link creation
     * @testIt Link points to frontend
     * @testIt Link contains the one-time sign-in token as query parameter
     * @testIt Link contains the redirect URL as query parameter
     * @testIt Link contains the email verification token as query parameter
     * @testIt Link contains the HMAC of the user's email address as query parameter
     * @testIt RedirectTo points to frontend URL
     * @testIt Calls createLoginLinkToken to obtain the sign-in and email-verification tokens
     * @testIt Email says when the link expires
     * @todo Implement
     */
    requestLoginLink(ctx: T, opts: {
        email: EmailAddress;
        redirectTo?: string;
    }): Promise<void>;

    /**
     * Login with the one-time sign-in link challenge, establishing a session and verifying the address if it is not verified yet.
     *
     * @throws {LoginLinkInvalidError} status=401 when the token is unknown, expired, or already redeemed
     * @throws {ExistingSessionError} status=400 when the user already has an active session
     *
     * @operation
     * @restOperation POST /login-link/consume
     * @restPublic
     * @testDescribe Login-link consumption
     * @testIt Consumes the one-time sign-in token and establishes a session
     * @testIt If user has existing session, throw ExistingSessionError
     * @testIt If the token is invalid, expired, or already redeemed, throw LoginLinkInvalidError
     * @testIt Verifies the user's email address if not already verified
     * @todo Implement 
     */
    consumeLoginLink(ctx: T, opts: LoginLinkChallenge): Promise<void>;
}
