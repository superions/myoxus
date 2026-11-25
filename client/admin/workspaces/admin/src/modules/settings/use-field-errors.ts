// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Shared field error state for Admin config pages, backed by Facade `useForm`
 * (`@mantine/form`).
 *
 * Preserves the server-backed draft baseline in `useAppConfig` (so native
 * disclosure/tab switches never wipe unsaved edits) while delegating per-field
 * error storage and clearing to `@mantine/form`.
 */
import { useForm } from "@myoxus/ui-facade";
import { useCallback, useMemo } from "react";

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
   * Callback to pass to config form field `onErrorChange`. Sets or clears the
   * error for the given field path in the backing Mantine form.
   */
  onFieldErrorChange: (field: string, error?: string) => void;
};

export function useFieldErrors(): UseFieldErrorsResult {
  const form = useForm<Record<string, unknown>>({
    initialValues: {},
  });
  const { setFieldError, clearFieldError } = form;

  const fieldErrors = useMemo<FieldErrorMap>(() => {
    const out: FieldErrorMap = {};
    for (const [key, value] of Object.entries(form.errors)) {
      if (typeof value === "string" && value.length > 0) {
        out[key] = value;
      }
    }
    return out;
  }, [form.errors]);

  const hasFieldError = useCallback(
    (modules: string[]) =>
      Object.keys(fieldErrors).some((k) =>
        modules.some((m) => k.startsWith(`${m}/`)),
      ),
    [fieldErrors],
  );

  const onFieldErrorChange = useCallback(
    (field: string, error?: string) => {
      if (error) {
        setFieldError(field, error);
      } else {
        clearFieldError(field);
      }
    },
    [clearFieldError, setFieldError],
  );

  return { fieldErrors, hasFieldError, onFieldErrorChange };
}
