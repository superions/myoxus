/**
 * @file root-store.ts — @myoxus/infra (atom)
 *
 * Accessor for the root Jotai atom store.
 *
 * Jotai's `getDefaultStore()` returns the single global store instance that
 * is shared across all atoms that do not specify a custom `Provider`.  Calling
 * this function from outside a React component tree (e.g. in a service or
 * effect) gives direct access to read/write atoms imperatively.
 *
 * Consumers: services in `client/web` and `client/admin` that need to access
 * atom state outside of React's render cycle.
 */

import { getDefaultStore } from "jotai";

/**
 * Returns the root Jotai atom store.
 *
 * Use this to read or write atoms from non-React contexts (e.g. service
 * constructors, WebSocket message handlers).
 *
 * @example
 * ```ts
 * const store = getCurrentStore();
 * const value = store.get(myAtom);
 * store.set(myAtom, newValue);
 * ```
 */
export function getCurrentStore() {
  return getDefaultStore();
}
