// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

export const PDF_EXPORT_COMPLETED_EVENT = "myoxus:pdf-export-completed";

export interface PdfExportCompletedDetail {
  workspaceId: string;
  docId: string;
  jobId: string;
  downloadUrl: string;
}

export function dispatchPdfExportCompleted(detail: PdfExportCompletedDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<PdfExportCompletedDetail>(PDF_EXPORT_COMPLETED_EVENT, {
      detail,
    }),
  );
}

export function isPdfExportCompletedEvent(
  event: Event,
): event is CustomEvent<PdfExportCompletedDetail> {
  if (!(event instanceof CustomEvent)) return false;
  const detail = event.detail as Partial<PdfExportCompletedDetail> | undefined;
  return (
    typeof detail?.workspaceId === "string" &&
    typeof detail.docId === "string" &&
    typeof detail.jobId === "string" &&
    typeof detail.downloadUrl === "string"
  );
}
