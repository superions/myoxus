// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";

type DisposableValue = Disposable | AsyncDisposable;
type DisposableState<T> = {
  data: T | null;
  loading: boolean;
  error: Error | null;
};

export function useDisposable<T extends DisposableValue>(
  disposableFn: (abortSignal?: AbortSignal) => Promise<T | null>,
  deps?: unknown[],
): DisposableState<T>;

export function useDisposable<T extends DisposableValue>(
  disposableFn: (abortSignal?: AbortSignal) => T | null,
  deps?: unknown[],
): { data: T | null };

export function useDisposable<T extends DisposableValue>(
  disposableFn: (abortSignal?: AbortSignal) => Promise<T | null> | T | null,
  deps?: unknown[],
): DisposableState<T> {
  const [state, setState] = useState<DisposableState<T>>({
    data: null,
    loading: false,
    error: null,
  });

  // The caller owns dependency stability. This hook mirrors React resource
  // lifetimes and must not infer deps from a disposable factory closure.
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(() => {
    const abortController = new AbortController();
    let currentValue: T | null = null;

    setState((prev) => ({ ...prev, loading: true, error: null }));

    Promise.resolve(disposableFn(abortController.signal))
      .then((data) => {
        currentValue = data;
        if (!abortController.signal.aborted) {
          setState({ data, loading: false, error: null });
        }
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setState((prev) => ({
            ...prev,
            error: error instanceof Error ? error : new Error(String(error)),
            loading: false,
          }));
        }
      });

    return () => {
      abortController.abort();

      if (currentValue && typeof currentValue === "object") {
        if (Symbol.dispose in currentValue) {
          currentValue[Symbol.dispose]();
        } else if (Symbol.asyncDispose in currentValue) {
          void currentValue[Symbol.asyncDispose]();
        }
      }
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, deps ?? []);

  return state;
}
