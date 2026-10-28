import type { AuthSession } from "../AuthSession.ts";

export interface SessionOperations<T> {
    /**
     * Answer the session the request carries, resolved from the context.
     *
     * @throws {SessionInvalidError} status=401 when the request carries no live session
     *
     * @operation
     * @restOperation GET /session/current
     * @todo Decide whether a session also exposes its own id, for listing and revoking signed-in browsers
     */
    currentSession(ctx: T): Promise<AuthSession>;

    /**
     * Revoke the request's session, resolved from the context; a request with no live session is already signed out.
     *
     * @operation
     * @restOperation POST /session/sign-out
     * @todo Implement sign-in before the route is generated
     */
    signOut(ctx: T): Promise<void>;
}
