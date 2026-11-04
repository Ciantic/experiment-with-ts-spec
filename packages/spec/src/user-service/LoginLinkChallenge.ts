import type { EmailVerificationChallenge } from "./EmailVerificationChallenge.ts";
import type { LoginLinkToken } from "./primitives/LoginLinkToken.ts";

/** A one-time sign-in token, the email-verification challenge the link carries, and when both stop working. */
export type LoginLinkChallenge = {
    token: LoginLinkToken;
    emailVerification: EmailVerificationChallenge;
    expiresAt: Date;
};
