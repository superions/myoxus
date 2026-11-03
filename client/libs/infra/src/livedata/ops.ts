/**
 * @file ops.ts — livedata RxJS operators for @myoxus/infra
 *
 * A collection of RxJS operator utilities designed to work ergonomically with
 * {@link LiveData} and the application's error model ({@link UserFriendlyError}).
 *
 * Key operators:
 *  - {@link mapInto}                      — writes stream values into a LiveData
 *  - {@link catchErrorInto}               — writes errors into a LiveData (resets on complete)
 *  - {@link fromPromise}                  — converts a Promise to an Observable with AbortSignal support
 *  - {@link backoffRetry}                 — exponential back-off retry with optional predicate
 *  - {@link smartRetry}                   — retries network errors infinitely, other errors N times
 *  - {@link exhaustMapSwitchUntilChanged} — hybrid exhaustMap/switchMap based on value equality
 *  - {@link onStart} / {@link onComplete} — lifecycle callbacks
 */

import { UserFriendlyError } from "@myoxus/error";
import {
  catchError,
  connect,
  defer,
  distinctUntilChanged,
  EMPTY,
  exhaustMap,
  filter,
  merge,
  mergeMap,
  Observable,
  type ObservableInput,
  type ObservedValueOf,
  of,
  type OperatorFunction,
  pipe,
  retry,
  switchMap,
  take,
  throwError,
  timer,
} from "rxjs";

import { MANUALLY_STOP } from "../utils";
import type { LiveData } from "./livedata";

export type AutomaticRetryProducer =
  | "connection"
  | "document-sync"
  | "blob-sync"
  | "indexer-sync"
  | "livedata"
  | "swr"
  | "telemetry";

type AutomaticRetryAdmission = (producer: AutomaticRetryProducer) => boolean;

let automaticRetryAdmission: AutomaticRetryAdmission | undefined;

/**
 * Installs the Browser Web retry-policy adapter without making infrastructure
 * own product policy. Native clients intentionally retain the default
 * admission behavior when no adapter is installed.
 */
export function configureAutomaticRetryAdmission(
  admission: AutomaticRetryAdmission,
): () => void {
  const previous = automaticRetryAdmission;
  automaticRetryAdmission = admission;
  return () => {
    if (automaticRetryAdmission === admission) {
      automaticRetryAdmission = previous;
    }
  };
}

/** Reserves one automatic retry at the last possible point before execution. */
export function reserveAutomaticRetry(
  producer: AutomaticRetryProducer,
): boolean {
  return automaticRetryAdmission?.(producer) ?? true;
}

/**
 * A temporary policy block pauses the retry, not its owning effect. Only the
 * admission check repeats; no data request runs until a slot is reserved.
 * RxJS teardown also cancels this wait when the effect is disposed.
 */
function waitForLiveDataRetryAdmission() {
  return timer(0, 1_000).pipe(
    filter(() => reserveAutomaticRetry("livedata")),
    take(1),
  );
}

/**
 * An operator that maps the value to the `LiveData`.
 */
export function mapInto<T>(l$: LiveData<T>) {
  return pipe(
    mergeMap((value: T) => {
      l$.next(value);
      return EMPTY;
    }),
  );
}

/**
 * An operator that catches the error and sends it to the `LiveData`.
 *
 * The `LiveData` will be set to `null` when the observable completes. This is useful for error state recovery.
 *
 * @param cb A callback that will be called when an error occurs.
 */
export function catchErrorInto<Error = any>(
  l$: LiveData<Error | null>,
  cb?: (error: Error) => void,
) {
  return pipe(
    onComplete(() => l$.next(null)),
    catchError((error: any) => {
      l$.next(error);
      cb?.(error);
      return EMPTY;
    }),
  );
}

/**
 * An operator that calls the callback when the observable starts.
 */
export function onStart<T>(cb: () => void): OperatorFunction<T, T> {
  return (observable$) =>
    new Observable((subscribe) => {
      cb();
      return observable$.subscribe(subscribe);
    });
}

/**
 * An operator that calls the callback when the observable completes.
 */
export function onComplete<T>(cb: () => void): OperatorFunction<T, T> {
  return (observable$) =>
    new Observable((subscribe) => {
      return observable$.subscribe({
        complete() {
          cb();
          subscribe.complete();
        },
        error(err) {
          subscribe.error(err);
        },
        next(value) {
          subscribe.next(value);
        },
      });
    });
}

/**
 * Convert a promise to an observable.
 *
 * like `from` but support `AbortSignal`.
 */
export function fromPromise<T>(
  promise: Promise<T> | ((signal: AbortSignal) => Promise<T>),
): Observable<T> {
  return new Observable((subscriber) => {
    const abortController = new AbortController();

    const rawPromise =
      promise instanceof Function ? promise(abortController.signal) : promise;

    rawPromise
      .then((value) => {
        subscriber.next(value);
        subscriber.complete();
      })
      .catch((error) => {
        subscriber.error(error);
      });

    return () => abortController.abort(MANUALLY_STOP);
  });
}

/**
 * An operator that retries the source observable when an error occurs.
 *
 * https://en.wikipedia.org/wiki/Exponential_backoff
 */
export function backoffRetry<T>({
  when,
  count = 3,
  delay = 200,
  maxDelay = 15000,
}: {
  when?: (err: any) => boolean;
  count?: number;
  delay?: number;
  maxDelay?: number;
} = {}) {
  return (obs$: Observable<T>) =>
    obs$.pipe(
      retry({
        count,
        delay: (err, retryIndex) => {
          if (when && !when(err)) {
            return throwError(() => err);
          }
          const d = Math.pow(2, retryIndex - 1) * delay;
          return timer(Math.min(d, maxDelay)).pipe(
            mergeMap(waitForLiveDataRetryAdmission),
          );
        },
      }),
    );
}

/**
 * An opinionated retry strategy that distinguishes network errors from server
 * errors:
 *  - Network errors (`NETWORK_ERROR`) are retried indefinitely with exponential
 *    back-off (suitable for offline / connection-lost scenarios).
 *  - All other errors are retried up to `count` times.
 *
 * @param count    - Maximum retries for non-network errors (default: 3).
 * @param delay    - Initial back-off delay in ms (default: 200).
 * @param maxDelay - Maximum back-off delay in ms (default: 15 000).
 */
export function smartRetry<T>({
  count = 3,
  delay = 200,
  maxDelay = 15000,
}: {
  count?: number;
  delay?: number;
  maxDelay?: number;
} = {}) {
  return (obs$: Observable<T>) =>
    defer(() => {
      let nonNetworkRetries = 0;
      return obs$.pipe(
        retry({
          count: Infinity,
          delay: (error, retryIndex) => {
            if (!UserFriendlyError.isNetworkError(error)) {
              nonNetworkRetries += 1;
              if (nonNetworkRetries > count) {
                return throwError(() => error);
              }
            }
            const retryDelay = Math.min(
              Math.pow(2, retryIndex - 1) * delay,
              maxDelay,
            );
            return timer(retryDelay).pipe(
              mergeMap(waitForLiveDataRetryAdmission),
            );
          },
        }),
      );
    });
}

/**
 * An operator that combines `exhaustMap` and `switchMap`.
 *
 * This operator executes the `comparator` on each input, acting as an `exhaustMap` when the `comparator` returns `true`
 * and acting as a `switchMap` when the comparator returns `false`.
 *
 * It is more useful for async processes that are relatively stable in results but sensitive to input.
 * For example, when requesting the user's subscription status, `exhaustMap` is used because the user's subscription
 * does not change often, but when switching users, the request should be made immediately like `switchMap`.
 *
 * @param onSwitch callback will be executed when `switchMap` occurs (including the first execution).
 */
export function exhaustMapSwitchUntilChanged<T, O extends ObservableInput<any>>(
  comparator: (previous: T, current: T) => boolean,
  project: (value: T, index: number) => O,
  onSwitch?: (value: T) => void,
): OperatorFunction<T, ObservedValueOf<O>> {
  return pipe(
    connect((shared$) =>
      shared$.pipe(
        distinctUntilChanged(comparator),
        switchMap((value) => {
          onSwitch?.(value);
          return merge(of(value), shared$).pipe(
            exhaustMap((value, index) => {
              return project(value, index);
            }),
          );
        }),
      ),
    ),
  );
}
