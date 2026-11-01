/**
 * @file store.ts — @myoxus/infra (framework/core/components)
 *
 * Base class for state-container components ("stores") in the DI framework.
 *
 * A `Store` is similar to a {@link Service} in that it is injectable and
 * singleton per scope, but semantically it holds reactive state rather than
 * purely providing logic.  Stores are typically backed by Jotai atoms or
 * similar reactive primitives and expose derived state to consumers.
 *
 * Usage:
 * ```ts
 * class WorkspaceStore extends Store {
 *   readonly workspaces$ = LiveData.from(...);
 * }
 * framework.impl(WorkspaceStore);
 * const store = provider.get(WorkspaceStore);
 * ```
 *
 * Consumers: state management modules in `client/web` and `client/admin`.
 */

import { Component } from "./component";

/**
 * Base class for singleton reactive state containers.
 *
 * The `__isStore` brand and `__injectable` flag are read by the DI container
 * to apply store-specific lifecycle rules and to allow the store to be resolved
 * via constructor injection.
 */
export class Store extends Component {
  readonly __isStore = true;
  readonly __injectable = true;
}
