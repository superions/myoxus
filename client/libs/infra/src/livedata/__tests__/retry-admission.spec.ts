import { Observable } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  backoffRetry,
  configureAutomaticRetryAdmission,
  smartRetry,
} from "../ops";

describe("automatic retry admission", () => {
  test.each([
    ["backoffRetry", backoffRetry<number>({ delay: 1 })],
    ["smartRetry", smartRetry<number>({ delay: 1 })],
  ] as const)(
    "%s waits without failing and resumes only when the Web gate admits it",
    async (_name, operator) => {
      vi.useFakeTimers();
      let subscriptions = 0;
      let admitted = false;
      const restore = configureAutomaticRetryAdmission(() => admitted);
      let failure: unknown;
      let value: number | undefined;

      const subscription = new Observable<number>((subscriber) => {
        subscriptions += 1;
        if (subscriptions === 1)
          subscriber.error(new Error("network unavailable"));
        else {
          subscriber.next(42);
          subscriber.complete();
        }
      })
        .pipe(operator)
        .subscribe({
          next: (next) => (value = next),
          error: (error) => (failure = error),
        });
      try {
        await vi.advanceTimersByTimeAsync(15_000);
        expect(subscriptions).toBe(1);
        expect(failure).toBeUndefined();
        admitted = true;
        await vi.advanceTimersByTimeAsync(1_000);
        expect(subscriptions).toBe(2);
        expect(value).toBe(42);
        expect(failure).toBeUndefined();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        subscription.unsubscribe();
        restore();
        vi.useRealTimers();
      }
    },
  );
});
