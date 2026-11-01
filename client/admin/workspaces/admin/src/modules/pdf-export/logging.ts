/**
 * @file PDF export admin UI logging helpers.
 *
 * The admin frontend intentionally keeps logging lightweight and structured:
 * browser logs are useful for operator support, while mutations themselves
 * are audited server-side. Keep event names stable so screenshots/log dumps
 * can be correlated with GraphQL audit events.
 */

type PdfExportLogLevel = "info" | "warn" | "error";

function compact(data: Record<string, unknown> | undefined) {
  if (!data) return undefined;
  return Object.fromEntries(
    Object.entries(data).filter(([, value]) => value !== undefined),
  );
}

/**
 * Emit a structured admin-UI log line for PDF export operations.
 *
 * Do not place secrets, file bytes, or raw manifests in `data`; log IDs,
 * slugs, counts, and validation states only.
 */
export function logPdfExportUiEvent(
  event: string,
  data?: Record<string, unknown>,
  level: PdfExportLogLevel = "info",
) {
  const payload = compact(data);
  const message = `[pdf-export-admin] ${event}`;
  if (level === "error") {
    console.error(message, payload ?? {});
    return;
  }
  if (level === "warn") {
    console.warn(message, payload ?? {});
    return;
  }
  console.info(message, payload ?? {});
}
