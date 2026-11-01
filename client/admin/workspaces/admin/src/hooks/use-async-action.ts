// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { type DependencyList, useCallback } from "react";

/**
 * Adapts an asynchronous UI action to React's synchronous event-handler shape.
 * Domain failures should be reported by the action itself; the final catch
 * prevents an unhandled rejection when a caller misses that boundary.
 */
export function useAsyncAction<Args extends unknown[]>(
  action: (...args: Args) => Promise<void>,
  dependencies: DependencyList,
): (...args: Args) => void {
  return useCallback((...args: Args) => {
    void action(...args).catch((error: unknown) => {
      console.error(error);
    });
    // The caller owns the action's semantic dependency list, like useCallback.
    // oxlint-disable-next-line react/exhaustive-deps
  }, dependencies);
}
