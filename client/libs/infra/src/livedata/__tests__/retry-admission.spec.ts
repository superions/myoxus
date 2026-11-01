import { Observable } from "rxjs";
import { describe, expect, test, vi } from "vitest";

import {
  AutomaticRetryBlockedError,
  backoffRetry,
  configureAutomaticRetryAdmission,
  smartRetry,
} from "../ops";

describe("automatic retry admission", () => {
  test.each([
    ["backoffRetry", backoffRetry({ delay: 1 })],
    ["smartRetry", smartRetry({ delay: 1 })],
  ] as const)(
    "%s cannot resubscribe when the Web gate denies it",
    async (_name, operator) => {
      vi.useFakeTimers();
      let subscriptions = 0;
      const restore = configureAutomaticRetryAdmission(() => false);
      let failure: unknown;

      new Observable<never>((subscriber) => {
        subscriptions += 1;
        subscriber.error(new Error("network unavailable"));
      })
        .pipe(operator)
        .subscribe({ error: (error) => (failure = error) });

      await vi.runAllTimersAsync();
      expect(subscriptions).toBe(1);
      expect(failure).toBeInstanceOf(AutomaticRetryBlockedError);

      restore();
      vi.useRealTimers();
    },
  );
});
