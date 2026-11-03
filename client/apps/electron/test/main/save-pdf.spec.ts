// SPDX-License-Identifier: AGPL-3.0-or-later
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ windows: [] as any[], dialog: vi.fn() }));
vi.mock("electron", () => ({
  app: { getPath: () => "/downloads" },
  BrowserWindow: { getAllWindows: () => mocks.windows },
  WebContentsView: class WebContentsView {},
  dialog: { showSaveDialog: mocks.dialog },
}));
import {
  nativeExportFilename,
  publishExport,
  saveExportFile,
} from "../../src/main/ui/save-file-export";
import { savePdf } from "../../src/main/ui/save-pdf";
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  mocks.windows = [];
  vi.clearAllMocks();
});
test("retains Unicode with bounded safe filenames", () => {
  expect(nativeExportFilename("Überblick/東京:2026.pdf", "pdf")).toBe(
    "Überblick-東京-2026.pdf",
  );
  expect(nativeExportFilename("CON.pdf", "pdf")).toBe("_CON.pdf");
  expect(nativeExportFilename("Überblick/東京:2026.docx", "docx")).toBe(
    "Überblick-東京-2026.docx",
  );
  expect(
    Buffer.byteLength(nativeExportFilename("東京".repeat(100), "pdf")),
  ).toBeLessThanOrEqual(244);
});
test("atomically publishes complete bytes without staging residue", async () => {
  directory = await mkdtemp(join(tmpdir(), "myoxus-pdf-"));
  const target = join(directory, "Überblick.docx");
  await writeFile(target, "previous");
  const bytes = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2]);
  const sender = { isDestroyed: () => false } as Electron.WebContents;
  mocks.windows = [{ webContents: sender, isDestroyed: () => false }];
  mocks.dialog.mockResolvedValue({ canceled: false, filePath: target });
  expect(
    await saveExportFile(sender, "docx", "Überblick.docx", bytes.buffer),
  ).toEqual({ status: "saved" });
  expect(await readFile(target)).toEqual(Buffer.from(bytes));
  expect(await readdir(directory)).toEqual(["Überblick.docx"]);
  expect(mocks.dialog).toHaveBeenCalledWith(
    mocks.windows[0],
    expect.objectContaining({
      filters: [{ name: "Word (.docx)", extensions: ["docx"] }],
    }),
  );
});
test("closed owners preserve the previous target and clean staging files", async () => {
  directory = await mkdtemp(join(tmpdir(), "myoxus-pdf-"));
  const target = join(directory, "previous.pdf");
  await writeFile(target, "previous");
  await expect(
    publishExport(target, Buffer.from("%PDF-1.7"), () => false),
  ).rejects.toThrow("window closed");
  expect(await readFile(target, "utf8")).toBe("previous");
  expect(await readdir(directory)).toEqual(["previous.pdf"]);
});
test("failed publication removes the temporary file", async () => {
  directory = await mkdtemp(join(tmpdir(), "myoxus-pdf-"));
  await expect(
    publishExport(directory, Buffer.from("%PDF-1.7"), () => true),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
});

test("invalid packages and open-ended formats never reach the chooser", async () => {
  const sender = { isDestroyed: () => false } as Electron.WebContents;
  mocks.windows = [{ webContents: sender, isDestroyed: () => false }];
  const invalid = new TextEncoder().encode(
    "<html>not a document</html>",
  ).buffer;
  await expect(savePdf(sender, "bad.pdf", invalid)).rejects.toThrow(
    "Invalid PDF",
  );
  await expect(
    saveExportFile(sender, "docx", "bad.docx", invalid),
  ).rejects.toThrow("Invalid DOCX");
  await expect(
    saveExportFile(sender, "exe" as "docx", "bad.exe", invalid),
  ).rejects.toThrow("Unsupported");
  expect(mocks.dialog).not.toHaveBeenCalled();
});
test("cancellation writes nothing and the dialog uses its requesting window", async () => {
  const sender = { isDestroyed: () => false } as Electron.WebContents;
  const owner = { webContents: sender, isDestroyed: () => false };
  mocks.windows = [
    {
      webContents: {},
      isDestroyed: () => false,
      contentView: { children: [] },
    },
    owner,
  ];
  mocks.dialog.mockResolvedValue({ canceled: true });
  expect(
    await savePdf(
      sender,
      "東京.pdf",
      new TextEncoder().encode("%PDF-1.7").buffer,
    ),
  ).toEqual({ status: "cancelled" });
  expect(mocks.dialog).toHaveBeenCalledWith(
    owner,
    expect.objectContaining({ defaultPath: "/downloads/東京.pdf" }),
  );
});

test("foreign requesters cannot use another window's dialog", async () => {
  const sender = { isDestroyed: () => false } as Electron.WebContents;
  await expect(savePdf(sender, "x.pdf", new ArrayBuffer(0))).rejects.toThrow(
    "window unavailable",
  );
  expect(mocks.dialog).not.toHaveBeenCalled();
});
