import { entityRoutes, type Route } from "infra";
import { operationRoutes } from "operations";

/** Every exposed call: id, verb, and path, as the router and the group resolve them. */
export const routes: Route[] = [
    ...entityRoutes,
    ...operationRoutes,
];

/** The same calls with every guard removed, for a server that skips the permission checks. */
export function withoutGuards(table: readonly Route[]): Route[] {
    return table.map((route) => {
        const copy: Route = { ...route };
        delete copy.guard;
        return copy;
    });
}
