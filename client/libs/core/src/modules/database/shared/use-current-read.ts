// SPDX-License-Identifier: AGPL-3.0-or-later

import { useCallback, useEffect, useRef, useState } from "react";
import type { SWRResponse } from "swr";
import { classifyDatabaseError } from "../route-state";

/** Cached projections do not authorize a newly opened owner. SWR's bare
 * mutate() resolves retained data even after a failed revalidation, so await
 * the actual native read promise through mutate instead. Its native timestamps
 * fence older pending requests without adding a separate cache lifetime.
 * Each attempt owns cancellation so GraphQL cannot deduplicate a new opening
 * onto a previous opening's still-running read.
 */
export function useDatabaseCurrentRead<Data>(
  key: string,
  enabled: boolean,
  fetchCurrent: (signal: AbortSignal) => Promise<Data>,
  read: Pick<SWRResponse<Data>, "mutate" | "error">,
) {
  const [state, setState] = useState<{
    key: string;
    enabled: boolean;
    admitted: boolean;
    error?: unknown;
  }>({ key, enabled, admitted: false });
  // A→disabled→A is a new opening even when SWR still holds A's projection.
  // Reset before children can render with a previous opening's admission.
  if (state.key !== key || state.enabled !== enabled)
    setState({ key, enabled, admitted: false });
  const latest = useRef({ key, enabled, fetchCurrent, mutate: read.mutate });
  latest.current = { key, enabled, fetchCurrent, mutate: read.mutate };
  const mounted = useRef(false);
  const sequence = useRef(0);
  const activeRead = useRef<AbortController | null>(null);
  const reload = useCallback(async () => {
    if (!enabled) return false;
    const scope = latest.current;
    if (scope.key !== key || !scope.enabled) return false;
    const attempt = ++sequence.current;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    try {
      let accepted = false;
      await scope.mutate(scope.fetchCurrent(controller.signal), {
        revalidate: false,
        throwOnError: true,
        populateCache: (data) => {
          accepted = true;
          return data;
        },
      });
      // A newer same-key read can supersede this native cache write. Its old
      // cached projection must not count as this opening's successful read.
      if (!accepted) throw new Error("Current read superseded");
      if (
        mounted.current &&
        !controller.signal.aborted &&
        latest.current.key === scope.key &&
        latest.current.enabled === scope.enabled &&
        sequence.current === attempt
      )
        setState({ key: scope.key, enabled: scope.enabled, admitted: true });
      return (
        mounted.current &&
        !controller.signal.aborted &&
        latest.current.key === scope.key &&
        latest.current.enabled === scope.enabled &&
        sequence.current === attempt
      );
    } catch (error) {
      if (
        mounted.current &&
        !controller.signal.aborted &&
        latest.current.key === scope.key &&
        latest.current.enabled === scope.enabled &&
        sequence.current === attempt
      )
        setState((previous) => ({
          key: scope.key,
          enabled: scope.enabled,
          admitted:
            previous.key === scope.key &&
            previous.enabled === scope.enabled &&
            previous.admitted,
          error,
        }));
      return false;
    } finally {
      if (activeRead.current === controller) activeRead.current = null;
    }
  }, [enabled, key]);
  useEffect(() => {
    mounted.current = true;
    const invalidate = () => {
      sequence.current++;
      activeRead.current?.abort();
      activeRead.current = null;
    };
    void reload();
    return () => {
      mounted.current = false;
      invalidate();
    };
  }, [reload]);
  const currentState = state.key === key && state.enabled === enabled;
  const localError = currentState ? state.error : undefined;
  const error =
    localError &&
    ["forbidden", "missing"].includes(classifyDatabaseError(localError))
      ? localError
      : (read.error ?? localError);
  return { admitted: enabled && currentState && state.admitted, error, reload };
}
