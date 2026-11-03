// SPDX-License-Identifier: AGPL-3.0-or-later
import type { FetchService } from "@myoxus/core/modules/server";
import { getDesktopBridge } from "@myoxus/desktop-api-contract/bridge";
import type { ExportFileFormat } from "@myoxus/desktop-api-contract";
import { download } from "@virgultum/editor/widgets/linked-doc";

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type FileDeliveryOutcome = "saved" | "provided" | "cancelled";

export class NativeFileExportUnavailable extends Error {}

export class ExportDownloadError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super("File download failed");
  }
}

/** Fetch only through the selected server's authenticated session. A denied
 * response never reaches the browser download or the native chooser. */
export async function fetchExportBlob(
  fetchService: Pick<FetchService, "fetch">,
  url: string,
  init?: Parameters<FetchService["fetch"]>[1],
): Promise<{ response: Response; blob: Blob }> {
  const response = await fetchService.fetch(url, {
    ...init,
    credentials: "include",
  });
  if (!response.ok) {
    let code: string | undefined;
    if (response.headers?.get("content-type")?.includes("application/json")) {
      try {
        const payload: unknown = await response.json();
        if (
          payload &&
          typeof payload === "object" &&
          "code" in payload &&
          typeof payload.code === "string"
        )
          code = payload.code;
      } catch {
        // HTTP status remains usable when a proxy or damaged response has no JSON.
      }
    }
    throw new ExportDownloadError(response.status, code);
  }
  return { response, blob: await response.blob() };
}

/** Browser delivery acknowledges provision of the download, not a disk write.
 * Main reports saved only after its atomic publication. PDF keeps its deployed
 * savePdf operation; DOCX must never be sent to an older client's PDF handler. */
export async function deliverExportBlob(
  blob: Blob,
  filename: string,
  format: ExportFileFormat,
  beforeNativeSave?: () => void,
): Promise<FileDeliveryOutcome> {
  let bytes: ArrayBuffer | undefined;
  if (format === "docx") {
    if (blob.type.split(";", 1)[0].trim().toLowerCase() !== DOCX_MIME) {
      throw new Error("Invalid DOCX download MIME type");
    }
    bytes = await blob.arrayBuffer();
    const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
    if (
      signature.length !== 4 ||
      !signature.every(
        (byte, index) => byte === [0x50, 0x4b, 0x03, 0x04][index],
      )
    ) {
      throw new Error("Invalid DOCX download signature");
    }
  }
  if (!BUILD_CONFIG.isElectron) {
    download(blob, filename);
    return "provided";
  }
  const bridge = getDesktopBridge();
  if (!bridge)
    throw new NativeFileExportUnavailable("Native file saving is unavailable");
  const ui = bridge.apis.ui;
  let result;
  if (format === "pdf") {
    bytes ??= await blob.arrayBuffer();
    beforeNativeSave?.();
    result = await ui.savePdf(filename, bytes);
  } else {
    const save = ui.saveExportFile;
    if (typeof save !== "function")
      throw new NativeFileExportUnavailable(
        "This desktop client must be updated to save Word files",
      );
    bytes ??= await blob.arrayBuffer();
    beforeNativeSave?.();
    result = await save(format, filename, bytes);
  }
  if (result.status !== "saved" && result.status !== "cancelled")
    throw new Error("Invalid native save result");
  return result.status;
}
