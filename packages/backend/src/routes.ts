import { entityRoutes, type Route } from "infra";
import { operationRoutes } from "operations";

/** Every exposed call: id, verb, and path, as the router and the group resolve them. */
export const routes: Route[] = [
    ...entityRoutes,
    ...operationRoutes,
];
