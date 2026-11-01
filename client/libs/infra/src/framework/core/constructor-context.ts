/**
 * @file constructor-context.ts — @myoxus/infra (framework/core)
 *
 * Thread-local-style context passed from the DI container to component
 * constructors.
 *
 * Because JavaScript is single-threaded, we can safely use a module-level
 * mutable variable as a "current context" slot.  The container sets
 * `CONSTRUCTOR_CONTEXT.current` immediately before calling `new Component()`
 * and resets it in a `finally` block, so the constructor can read the
 * provider and props without being passed them explicitly as arguments.
 *
 * This pattern avoids the need for constructor parameter injection and keeps
 * component signatures clean (no `constructor(framework, props)` boilerplate).
 *
 * @internal — Do NOT use outside of `framework/core/`.
 */

import type { FrameworkProvider } from "./provider";

/** The shape of the context slot. */
interface Context {
  /** The provider creating the component. */
  provider?: FrameworkProvider;
  /** The props passed to the component (for entities and scopes). */
  props?: any;
}

/**
 * Module-level context slot read by {@link Component} constructors to obtain
 * their `framework` and `props` values.
 *
 * Set by the container via {@link withContext} around each `new Component()` call.
 *
 * @internal
 */
export const CONSTRUCTOR_CONTEXT: {
  current: Context;
} = { current: {} };

/**
 * Executes `cb` with `CONSTRUCTOR_CONTEXT.current` set to `context`,
 * restoring the previous context value afterwards (even if `cb` throws).
 *
 * @param cb      - The callback to execute (typically `() => new MyComponent()`).
 * @param context - The provider and props to make available during construction.
 * @returns The return value of `cb`.
 *
 * @internal
 */
export function withContext<T>(cb: () => T, context: Context): T {
  const pre = CONSTRUCTOR_CONTEXT.current;
  try {
    CONSTRUCTOR_CONTEXT.current = context;
    return cb();
  } finally {
    CONSTRUCTOR_CONTEXT.current = pre;
  }
}
