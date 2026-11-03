// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Store } from "@virgultum/editor/store";
import type { Workspace } from "../workspace";
import type { FetchService } from "../server";
import type { ConversionWarning } from "../doc/services/docs";
import {
  deliverExportBlob,
  ExportDownloadError,
  fetchExportBlob,
  NativeFileExportUnavailable,
  type FileDeliveryOutcome,
} from "./deliver-file";
import { waitForServerDocumentSync } from "./source-sync";

export type DocxExportPhase = "sync" | "prepare" | "save";
export type DocxExportFailure =
  | "unavailable"
  | "mode"
  | "permission"
  | "sync"
  | "connection"
  | "conversion"
  | "empty"
  | "size"
  | "save"
  | "update";
export class DocxExportError extends Error {
  constructor(readonly reason: DocxExportFailure) {
    super("Word export failed");
  }
}
export type DocxExportOptions = {
  page: Store;
  workspace: Workspace;
  pageMode: "page" | "edgeless";
  fetchService?: Pick<FetchService, "fetch">;
};
export type DocxExportResult = {
  filename: string;
  warnings: ConversionWarning[];
  outcome: FileDeliveryOutcome;
};

function warningsFromHeader(value: string | null): ConversionWarning[] {
  if (value === null) throw new DocxExportError("conversion");
  try {
    const data: unknown = JSON.parse(value);
    if (
      !Array.isArray(data) ||
      !data.every(
        (warning) =>
          warning &&
          typeof warning === "object" &&
          typeof warning.code === "string" &&
          Number.isSafeInteger(warning.count) &&
          warning.count > 0,
      )
    ) {
      throw new Error("Invalid conversion diagnostics");
    }
    return data;
  } catch {
    throw new DocxExportError("conversion");
  }
}

function filenameFromHeader(header: string | null, title: string) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  let source = title;
  if (encoded) {
    try {
      source = decodeURIComponent(encoded);
    } catch {
      throw new DocxExportError("conversion");
    }
  }
  source = source
    .replace(/\.docx$/i, "")
    .replace(/[\p{Cc}/\\?%*:|"<>]/gu, "-")
    .replace(/[. ]+$/g, "");
  let stem = "";
  for (const character of source) {
    if (new TextEncoder().encode(stem + character).length > 240) break;
    stem += character;
  }
  return `${stem || "export"}.docx`;
}

/** Read-only delivery of one server snapshot. No PDF assignment, version
 * capture, export job, local document or automatic retry is created here. */
export async function runServerDocxExport(
  { page, workspace, pageMode, fetchService }: DocxExportOptions,
  progress: (phase: DocxExportPhase) => void,
): Promise<DocxExportResult> {
  if (pageMode !== "page") throw new DocxExportError("mode");
  if (workspace.flavour === "local" || !fetchService || !navigator.onLine)
    throw new DocxExportError("unavailable");
  progress("sync");
  if (!(await waitForServerDocumentSync(page, workspace)))
    throw new DocxExportError("sync");
  progress("prepare");
  let download;
  try {
    download = await fetchExportBlob(
      fetchService,
      `/api/workspaces/${encodeURIComponent(workspace.id)}/docs/${encodeURIComponent(page.id)}/export/docx`,
      { method: "POST", timeout: 130_000, throwOnHttpError: false },
    );
  } catch (cause) {
    if (cause instanceof ExportDownloadError) {
      if ([401, 403, 404].includes(cause.status))
        throw new DocxExportError("permission");
      if (cause.status === 413) throw new DocxExportError("size");
      if (cause.code === "empty_docx") throw new DocxExportError("empty");
      if (cause.code === "unsupported_mode") throw new DocxExportError("mode");
      if ([429, 502, 503, 504].includes(cause.status))
        throw new DocxExportError("connection");
      throw new DocxExportError("conversion");
    }
    throw new DocxExportError("connection");
  }
  const warnings = warningsFromHeader(
    download.response.headers.get("x-myoxus-conversion-warnings"),
  );
  const filename = filenameFromHeader(
    download.response.headers.get("content-disposition"),
    page.meta?.title ?? "export",
  );
  let saving = false;
  try {
    const outcome = await deliverExportBlob(
      download.blob,
      filename,
      "docx",
      () => {
        saving = true;
        progress("save");
      },
    );
    return { filename, warnings, outcome };
  } catch (cause) {
    if (cause instanceof NativeFileExportUnavailable)
      throw new DocxExportError("update");
    throw new DocxExportError(saving ? "save" : "conversion");
  }
}
