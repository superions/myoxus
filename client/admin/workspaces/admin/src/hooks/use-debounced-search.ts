/**
 * Hook that encapsulates the debounced keyword search pattern used by data
 * table toolbars. Keeps a local input value in sync with an external
 * `keyword` prop and emits the trimmed, debounced value via `setKeyword`.
 *
 * @param keyword - Controlled keyword value from the parent (used to sync
 *   when the parent resets filters externally).
 * @param onKeywordChange - Callback invoked with the trimmed debounced value.
 * @param delay - Debounce delay in milliseconds.
 * @returns `{ value, onValueChange }` — bind these to the search `<Input>`.
 */
import { type ChangeEvent, useCallback, useEffect, useState } from "react";

export interface UseDebouncedSearchOptions {
  /** Controlled keyword value from the parent. */
  keyword: string;
  /** Callback invoked with the trimmed debounced value. */
  onKeywordChange: (keyword: string) => void;
  /** Debounce delay in milliseconds. */
  delay: number;
}

export interface UseDebouncedSearchReturn {
  /** Current raw input value (not yet debounced). */
  value: string;
  /** Change handler to bind to the search `<Input>`. */
  onValueChange: (e: ChangeEvent<HTMLInputElement>) => void;
  /** String handler for shared UI facade inputs. */
  onTextChange: (value: string) => void;
}

export function useDebouncedSearch({
  keyword,
  onKeywordChange,
  delay,
}: UseDebouncedSearchOptions): UseDebouncedSearchReturn {
  const [value, setValue] = useState(keyword);

  useEffect(() => {
    setValue(keyword);
  }, [keyword]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      onKeywordChange(value.trim());
    }, delay);

    return () => window.clearTimeout(timer);
  }, [delay, onKeywordChange, value]);

  const onValueChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setValue(e.currentTarget.value);
  }, []);

  const onTextChange = useCallback((nextValue: string) => {
    setValue(nextValue);
  }, []);

  return { value, onValueChange, onTextChange };
}
