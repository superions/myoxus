/**
 * @file react.ts — livedata/react bindings for @myoxus/infra
 *
 * React hook integration for {@link LiveData}.  Uses `useSyncExternalStore`
 * (React 18+) so that transitions and concurrent rendering are handled
 * correctly without tearing.
 */

import { useSyncExternalStore } from "react";

import type { LiveData } from "./livedata";

function noopSubscribe() {
  return () => {};
}

function nullGetSnapshot() {
  return null;
}

function undefinedGetSnapshot() {
  return undefined;
}

/**
 * Subscribes to a {@link LiveData} and returns its current value as React state.
 *
 * Accepts `null` or `undefined` as the `liveData` argument — in those cases
 * the hook returns `null` or `undefined` respectively, matching the input type.
 * This makes it safe to use before a LiveData instance has been resolved:
 *
 * ```ts
 * const session$ = useService(SessionService).session$; // LiveData<Session | null>
 * const session = useLiveData(session$); // Session | null
 * ```
 *
 * The component re-renders whenever the LiveData value changes
 * (via `distinctUntilChanged` on the underlying BehaviorSubject).
 */
export function useLiveData<Input extends LiveData<any> | null | undefined>(
  liveData: Input,
): NonNullable<Input> extends LiveData<infer T>
  ? Input extends undefined
    ? T | undefined
    : Input extends null
      ? T | null
      : T
  : never {
  return useSyncExternalStore(
    liveData ? liveData.reactSubscribe : noopSubscribe,
    liveData
      ? liveData.reactGetSnapshot
      : liveData === undefined
        ? undefinedGetSnapshot
        : nullGetSnapshot,
  );
}
