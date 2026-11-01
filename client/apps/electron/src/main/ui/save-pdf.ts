// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow, dialog, WebContentsView } from "electron";

/** The chooser belongs to the requesting view, never the currently active window. */
export function pdfSaveWindow(
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

export function nativePdfFilename(filename: string): string {
  const base = filename
    .replace(/\.pdf$/i, "")
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
  return `${bounded || "export"}.pdf`;
}

/** A failed write/closed owner leaves the previous target intact and removes staging bytes. */
export async function publishPdf(
  path: string,
  bytes: Uint8Array,
  isAlive: () => boolean,
): Promise<void> {
  const temporary = join(dirname(path), `.myoxus-pdf-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = undefined;
    if (!isAlive()) throw new Error("PDF save window closed");
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function savePdf(
  sender: Electron.WebContents,
  filename: string,
  bytes: ArrayBuffer,
): Promise<{ status: "saved" } | { status: "cancelled" }> {
  const window = pdfSaveWindow(sender);
  if (!window || sender.isDestroyed())
    throw new Error("PDF save window unavailable");
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw new Error("Invalid PDF download");
  const isAlive = () =>
    !sender.isDestroyed() &&
    !window.isDestroyed() &&
    pdfSaveWindow(sender) === window;
  const result = await dialog.showSaveDialog(window, {
    defaultPath: join(app.getPath("downloads"), nativePdfFilename(filename)),
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled) return { status: "cancelled" };
  if (!result.filePath || !isAlive()) throw new Error("PDF save window closed");
  await publishPdf(result.filePath, buffer, isAlive);
  return { status: "saved" };
}
