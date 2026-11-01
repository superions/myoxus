/**
 * Shared field error state for config pages.
 *
 * Provides `fieldErrors`, `hasFieldError`, and `onFieldErrorChange` which are
 * identical in every config page (AI, Performance, Queue, System).
 * Extracting this hook eliminates the duplication and gives a single
 * testable unit.
 */
import { useCallback, useState } from "react";

export type FieldErrorMap = Record<string, string>;

export type UseFieldErrorsResult = {
  /** Current field error map: fieldPath → error message. */
  fieldErrors: FieldErrorMap;
  /**
   * Returns true if any field belonging to one of the given modules has a
   * validation error. Module matching uses the `"module/"` path prefix.
   */
  hasFieldError: (modules: string[]) => boolean;
  /**
   * Callback to pass to config form field `onErrorChange`. Sets or clears the error
   * for the given field path.
   */
  onFieldErrorChange: (field: string, error?: string) => void;
};

/**
 * Hook for managing per-field validation errors on config pages.
 *
 * Usage:
 * ```tsx
 * const { fieldErrors, hasFieldError, onFieldErrorChange } = useFieldErrors();
 * // Pass onFieldErrorChange to each config form field
 * // Use hasFieldError(['moduleName']) to disable Save button
 * ```
 */
export function useFieldErrors(): UseFieldErrorsResult {
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});

  const hasFieldError = useCallback(
    (modules: string[]) =>
      Object.keys(fieldErrors).some((k) =>
        modules.some((m) => k.startsWith(`${m}/`)),
      ),
    [fieldErrors],
  );

  const onFieldErrorChange = useCallback((field: string, error?: string) => {
    setFieldErrors((prev) => {
      if (error) {
        if (prev[field] === error) return prev;
        return { ...prev, [field]: error };
      }
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  return { fieldErrors, hasFieldError, onFieldErrorChange };
}
