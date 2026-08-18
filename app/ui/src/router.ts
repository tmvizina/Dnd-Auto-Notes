export const ROUTES = ["sessions", "review", "notes", "settings"] as const;

export type Route = (typeof ROUTES)[number];

const DEFAULT_ROUTE: Route = "sessions";

function isRoute(value: string): value is Route {
  return (ROUTES as readonly string[]).includes(value);
}

/** Parse a hash without making the rest of the app depend on browser APIs. */
export function routeFromHash(hash: string): Route {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const path = raw.startsWith("/") ? raw.slice(1) : raw;
  const [firstSegment] = path.split("/");
  return firstSegment !== undefined && isRoute(firstSegment) ? firstSegment : DEFAULT_ROUTE;
}

export function hashForRoute(route: Route): string {
  return `#/${route}`;
}

export interface HashRouter {
  readonly route: Route;
  readonly navigate: (route: Route) => void;
}

/** A small subscription-free helper for non-React consumers and tests. */
export function createHashRouter(
  getHash: () => string,
  setHash: (hash: string) => void,
): HashRouter {
  let current = routeFromHash(getHash());
  return {
    get route(): Route {
      current = routeFromHash(getHash());
      return current;
    },
    navigate: (route) => {
      current = route;
      setHash(hashForRoute(route));
    },
  };
}

export function canUseWindow(value: unknown): value is Window {
  return typeof value === "object" && value !== null && "location" in value;
}
