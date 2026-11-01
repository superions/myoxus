/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { useFilterPagination } from "./use-filter-pagination";

describe("useFilterPagination", () => {
  test("resets pageIndex to 0 when filterKey changes", () => {
    const { result, rerender } = renderHook(
      ({ filterKey }) => useFilterPagination(filterKey),
      { initialProps: { filterKey: "a" } },
    );

    // Navigate to page 3
    act(() => {
      result.current.setPagination((prev) => ({ ...prev, pageIndex: 3 }));
    });
    expect(result.current.pagination.pageIndex).toBe(3);

    // Change filter — should reset to page 0
    rerender({ filterKey: "b" });
    expect(result.current.pagination.pageIndex).toBe(0);
  });

  test("does not reset pageIndex when filterKey stays the same", () => {
    const { result, rerender } = renderHook(
      ({ filterKey }) => useFilterPagination(filterKey),
      { initialProps: { filterKey: "same" } },
    );

    act(() => {
      result.current.setPagination((prev) => ({ ...prev, pageIndex: 5 }));
    });
    expect(result.current.pagination.pageIndex).toBe(5);

    // Rerender with same filterKey
    rerender({ filterKey: "same" });
    expect(result.current.pagination.pageIndex).toBe(5);
  });
});
