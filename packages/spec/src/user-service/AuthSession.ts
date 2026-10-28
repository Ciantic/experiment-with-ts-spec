import type { EmailAddress } from "../primitives/EmailAddress.ts";
import type { UserId } from "./User.ts";

/**
 * User session
 */
export type UserAuthSession = {
    type: "user";
    user: {
        id: UserId;
        email: EmailAddress;
    };
};

/**
 * API key session
 */
export type ApiKeyAuthSession = {
    type: "api-key";
    // TODO: Will be determined later
};

/**
 * Authenticated session
 */
export type AuthSession = UserAuthSession | ApiKeyAuthSession;

