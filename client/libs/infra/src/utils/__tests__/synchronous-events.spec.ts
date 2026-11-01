import { Subject, type Subscription } from "rxjs";
import { describe, expect, test } from "vitest";
import { subscribeSynchronousEvents } from "../synchronous-events";

describe("synchronous event subscriptions", () => {
  test("preserves snapshots, registration order, duplicate callbacks and disposal", () => {
    const events = new Subject<number>();
    const received: string[] = [];
    let second: Subscription;
    let added = false;
    const first = subscribeSynchronousEvents(events, (value) => {
      received.push(`first:${value}`);
      second.unsubscribe();
      if (!added) {
        added = true;
        subscribeSynchronousEvents(events, (v) => received.push(`new:${v}`));
      }
    });
    second = subscribeSynchronousEvents(events, (value) =>
      received.push(`second:${value}`),
    );
    events.next(1);
    events.next(2);
    first.unsubscribe();
    events.next(3);
    expect(received).toEqual([
      "first:1",
      "second:1",
      "first:2",
      "new:2",
      "new:3",
    ]);
    const callback = (value: number) => received.push(`duplicate:${value}`);
    const a = subscribeSynchronousEvents(events, callback);
    subscribeSynchronousEvents(events, callback);
    a.unsubscribe();
    events.next(4);
    expect(received.slice(-2)).toEqual(["new:4", "duplicate:4"]);
    events.complete();
    events.next(5);
    expect(received.at(-1)).toBe("duplicate:4");
  });
  test("throws to the publisher and stops the current emission", () => {
    const events = new Subject<number>();
    const error = new Error("listener failed");
    const received: number[] = [];
    const bad = subscribeSynchronousEvents(events, () => {
      throw error;
    });
    subscribeSynchronousEvents(events, (value) => received.push(value));
    expect(() => events.next(1)).toThrow(error);
    expect(received).toEqual([]);
    bad.unsubscribe();
    events.next(2);
    expect(received).toEqual([2]);
  });
  test("delivers reentrant emissions in the same stack", () => {
    const events = new Subject<number>();
    const received: string[] = [];
    subscribeSynchronousEvents(events, (value) => {
      received.push(`first:${value}`);
      if (value === 1) events.next(2);
    });
    subscribeSynchronousEvents(events, (value) =>
      received.push(`second:${value}`),
    );
    events.next(1);
    expect(received).toEqual(["first:1", "first:2", "second:2", "second:1"]);
  });
});
