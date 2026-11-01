/**
 * @file PDF export admin hook for stable UI event logging.
 *
 * Components use this hook when callbacks need a memoized logger. The actual
 * logging backend stays in `../logging` so non-React helpers can emit the same
 * structured event shape.
 */
import { useCallback } from "react";

import { logPdfExportUiEvent } from "../logging";

/**
 * Return a memoized logger scoped to the PDF export admin module.
 */
export function usePdfExportUiLog() {
  return useCallback(
    (
      event: string,
      data?: Record<string, unknown>,
      level?: "info" | "warn" | "error",
    ) => logPdfExportUiEvent(event, data, level),
    [],
  );
}
