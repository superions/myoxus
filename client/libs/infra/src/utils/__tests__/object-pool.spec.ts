import { afterEach, describe, expect, it, vi } from "vitest";

import { ObjectPool } from "../object-pool";

describe("ObjectPool GC scheduling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses one-shot GC retries for deferred dangling objects", () => {
    vi.useFakeTimers();
    const onDangling = vi.fn(() => false);
    const pool = new ObjectPool<string, object>({ onDangling });

    const ref = pool.put("workspace", {});
    ref.release();

    vi.advanceTimersByTime(1000);
    expect(onDangling).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(4999);
    expect(onDangling).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(onDangling).toHaveBeenCalledTimes(2);
  });

  it("stops scheduling once a dangling object can be deleted", () => {
    vi.useFakeTimers();
    let canDelete = false;
    const onDelete = vi.fn();
    const pool = new ObjectPool<string, object>({
      onDangling: () => canDelete,
      onDelete,
    });

    const ref = pool.put("doc", {});
    ref.release();

    vi.advanceTimersByTime(1000);
    expect(onDelete).not.toHaveBeenCalled();

    canDelete = true;
    vi.advanceTimersByTime(5000);
    expect(onDelete).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10_000);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
