/**
 * @file scope.ts — @myoxus/infra (framework/core)
 *
 * Utility for serialising the DI scope stack.
 *
 * Consumers: `provider.ts`, `framework.ts` — for debug logging and keying
 * internal maps.
 */

import type { FrameworkScopeStack } from "./types";

/**
 * Serialises a {@link FrameworkScopeStack} into a slash-separated string.
 *
 * Example: `['workspace', 'editor']` → `'workspace/editor'`
 *
 * Used as a human-readable scope key in debug output.
 *
 * @param scope - The ordered array of scope names from the root downward.
 * @returns A slash-separated string representation.
 */
export function stringifyScope(scope: FrameworkScopeStack): string {
  return scope.join("/");
}
