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
  nativePdfFilename,
  publishPdf,
  savePdf,
} from "../../src/main/ui/save-pdf";
let directory: string | undefined;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
  mocks.windows = [];
  vi.clearAllMocks();
});
test("retains Unicode with bounded safe filenames", () => {
  expect(nativePdfFilename("Überblick/東京:2026.pdf")).toBe(
    "Überblick-東京-2026.pdf",
  );
  expect(nativePdfFilename("CON.pdf")).toBe("_CON.pdf");
  expect(
    Buffer.byteLength(nativePdfFilename("東京".repeat(100))),
  ).toBeLessThanOrEqual(244);
});
test("atomically publishes complete bytes without staging residue", async () => {
  directory = await mkdtemp(join(tmpdir(), "myoxus-pdf-"));
  const target = join(directory, "Überblick.pdf");
  await writeFile(target, "previous");
  const bytes = Buffer.from("%PDF-1.7\ncomplete bytes\n%%EOF");
  await publishPdf(target, bytes, () => true);
  expect(await readFile(target)).toEqual(bytes);
  expect(await readdir(directory)).toEqual(["Überblick.pdf"]);
});
test("closed owners preserve the previous target and clean staging files", async () => {
  directory = await mkdtemp(join(tmpdir(), "myoxus-pdf-"));
  const target = join(directory, "previous.pdf");
  await writeFile(target, "previous");
  await expect(
    publishPdf(target, Buffer.from("%PDF-1.7"), () => false),
  ).rejects.toThrow("window closed");
  expect(await readFile(target, "utf8")).toBe("previous");
  expect(await readdir(directory)).toEqual(["previous.pdf"]);
});
test("failed publication removes the temporary file", async () => {
  directory = await mkdtemp(join(tmpdir(), "myoxus-pdf-"));
  await expect(
    publishPdf(directory, Buffer.from("%PDF-1.7"), () => true),
  ).rejects.toThrow();
  expect(await readdir(directory)).toEqual([]);
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
