// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, WebContentsView } from "electron";
import type { ExportFileFormat } from "@myoxus/desktop-api-contract";

/** The chooser belongs to the requesting view, never the currently active window. */
export function exportSaveWindow(
  sender: Electron.WebContents,
): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(
    (window) =>
      !window.isDestroyed() &&
      (window.webContents === sender ||
        window.contentView.children.some(
          (view) =>
            view instanceof WebContentsView && view.webContents === sender,
        )),
  );
}

export function nativeExportFilename(
  filename: string,
  format: ExportFileFormat,
): string {
  const base = filename
    .replace(format === "pdf" ? /\.pdf$/i : /\.docx$/i, "")
    .replace(/[\p{Cc}/\\?%*:|"<>]/gu, "-")
    .replace(/[. ]+$/g, "");
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base)
    ? `_${base}`
    : base;
  let bounded = "";
  for (const character of safe) {
    if (Buffer.byteLength(bounded + character) > 240) break;
    bounded += character;
  }
  return `${bounded || "export"}.${format}`;
}

/** A failed write/closed owner leaves the previous target intact and removes staging bytes. */
export async function publishExport(
  path: string,
  bytes: Uint8Array,
  isAlive: () => boolean,
): Promise<void> {
  const temporary = join(dirname(path), `.myoxus-export-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    if (!isAlive()) throw new Error("File save window closed");
    await rename(temporary, path);
  } finally {
    try {
      await file?.close();
    } finally {
      await unlink(temporary).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}

export async function saveExportFile(
  sender: Electron.WebContents,
  format: ExportFileFormat,
  filename: string,
  bytes: ArrayBuffer,
): Promise<{ status: "saved" } | { status: "cancelled" }> {
  if (format !== "pdf" && format !== "docx")
    throw new Error("Unsupported file export format");
  const window = exportSaveWindow(sender);
  if (!window || sender.isDestroyed())
    throw new Error("File save window unavailable");
  if (!(bytes instanceof ArrayBuffer)) throw new Error("Invalid file download");
  const buffer = Buffer.from(bytes);
  if (format === "pdf" && !buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new Error("Invalid PDF download");
  if (
    format === "docx" &&
    !buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  )
    throw new Error("Invalid DOCX download");
  const isAlive = () =>
    !sender.isDestroyed() &&
    !window.isDestroyed() &&
    exportSaveWindow(sender) === window;
  const result = await dialog.showSaveDialog(window, {
    defaultPath: join(
      app.getPath("downloads"),
      nativeExportFilename(filename, format),
    ),
    filters: [
      { name: format === "pdf" ? "PDF" : "Word (.docx)", extensions: [format] },
    ],
  });
  if (result.canceled) return { status: "cancelled" };
  if (!result.filePath || !isAlive())
    throw new Error("File save window closed");
  await publishExport(result.filePath, buffer, isAlive);
  return { status: "saved" };
}
