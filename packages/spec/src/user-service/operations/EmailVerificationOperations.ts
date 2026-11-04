import type { EmailAddress } from "../../primitives/EmailAddress.ts";
import type { EmailVerificationChallenge } from "../EmailVerificationChallenge.ts";

/**
 * @todo Expose the contract over REST once a frontend verification flow exists
 */
export interface EmailVerificationOperations<T> {
    /**
     * Create a one-time verification token and the HMAC that binds it to the address.
     *
     * @operation
     * @testDescribe Email-verification challenge creation
     * @testIt Creates a one-time token and the HMAC of the address
     * @testIt Signs the address and expiry with the server secret
     * @testIt Expires the token
     */
    createEmailVerificationToken(ctx: T, opts: {
        email: EmailAddress;
    }): Promise<EmailVerificationChallenge>;

    /**
     * Mail a one-time link that proves the address, if a user exists with that email.
     *
     * @operation
     * @testDescribe Email-verification request
     * @testIt Link points to frontend
     * @testIt Link contains the one-time verification token as query parameter
     * @testIt Link contains the HMAC of the user's email address as query parameter
     * @testIt Mails nothing when no user has the address
     * @testIt Email says when the link expires
     * @todo Implement later
     */
    requestEmailVerification(ctx: T, opts: {
        email: EmailAddress;
        redirectTo?: string;
    }): Promise<void>;

    /**
     * Prove the address with the one-time verification link.
     *
     * @throws {EmailVerificationInvalidError} status=401 when the token is invalid or expired, or the HMAC does not match
     *
     * @operation
     * @testDescribe Email-verification consumption
     * @testIt Marks the user's email address verified
     * @testIt Leaves an already verified address unchanged
     * @testIt If the token is invalid or expired, throw EmailVerificationInvalidError
     * @testIt If the HMAC does not match the token's address, throw EmailVerificationInvalidError
     * @todo This needs REST endpoint later
     */
    consumeEmailVerification(ctx: T, opts: EmailVerificationChallenge): Promise<void>;
}
