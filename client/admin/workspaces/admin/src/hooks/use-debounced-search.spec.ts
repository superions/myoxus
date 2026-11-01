/** @vitest-environment happy-dom */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";

import { useDebouncedSearch } from "./use-debounced-search";

describe("useDebouncedSearch", () => {
  test("calls onKeywordChange with trimmed value after debounce", () => {
    vi.useFakeTimers();
    const onKeywordChange = vi.fn();
    const { result } = renderHook(() =>
      useDebouncedSearch({ keyword: "", onKeywordChange, delay: 500 }),
    );

    act(() => {
      result.current.onValueChange({
        currentTarget: { value: "  search term  " },
      } as React.ChangeEvent<HTMLInputElement>);
    });

    expect(onKeywordChange).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onKeywordChange).toHaveBeenLastCalledWith("search term");

    vi.useRealTimers();
  });

  test("syncs local value when keyword prop changes externally", () => {
    const onKeywordChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ keyword }) =>
        useDebouncedSearch({ keyword, onKeywordChange, delay: 300 }),
      { initialProps: { keyword: "initial" } },
    );

    expect(result.current.value).toBe("initial");

    rerender({ keyword: "external" });

    expect(result.current.value).toBe("external");
  });
});
