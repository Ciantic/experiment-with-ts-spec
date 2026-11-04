import type { EmailVerificationHmac } from "./primitives/EmailVerificationHmac.ts";
import type { EmailVerificationToken } from "./primitives/EmailVerificationToken.ts";

/** A one-time verification token, the HMAC that binds it to an address, and when it stops working. */
export type EmailVerificationChallenge = {
    token: EmailVerificationToken;
    emailHmac: EmailVerificationHmac;
    expiresAt: Date;
};
