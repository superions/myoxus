// SPDX-License-Identifier: AGPL-3.0-or-later
import { saveExportFile } from "./save-file-export";

/** Preserve the deployed PDF bridge, including its byte validation in Main. */
export function savePdf(
  sender: Electron.WebContents,
  filename: string,
  bytes: ArrayBuffer,
) {
  return saveExportFile(sender, "pdf", filename, bytes);
}
