/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from "vitest";
const mocks = vi.hoisted(() => ({ save: vi.fn(), download: vi.fn() }));
vi.mock("@myoxus/desktop-api-contract/bridge", () => ({
  getDesktopBridge: () => ({ apis: { ui: { savePdf: mocks.save } } }),
}));
vi.mock("@virgultum/editor/widgets/linked-doc", () => ({
  download: mocks.download,
}));
import { saveServerPdf } from "../save-server-pdf";
import { I18n } from "@myoxus/i18n";
const original = BUILD_CONFIG.isElectron;
afterEach(() => {
  BUILD_CONFIG.isElectron = original;
  vi.clearAllMocks();
});

test("uses the owning session and passes exact complete bytes to Main", async () => {
  BUILD_CONFIG.isElectron = true;
  const bytes = new TextEncoder().encode("%PDF-1.7\ncontent\n%%EOF").buffer;
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => ({ arrayBuffer: async () => bytes }),
  });
  mocks.save.mockResolvedValue({ status: "saved" });
  expect(
    await saveServerPdf({ fetch }, "/api/pdf-export/job/download", "東京.pdf"),
  ).toBe(true);
  expect(fetch).toHaveBeenCalledWith("/api/pdf-export/job/download", {
    credentials: "include",
  });
  expect(mocks.save).toHaveBeenCalledWith("東京.pdf", bytes);
  expect(mocks.download).not.toHaveBeenCalled();
});
test("cancel is neutral and denied downloads never reach the native chooser", async () => {
  BUILD_CONFIG.isElectron = true;
  mocks.save.mockResolvedValue({ status: "cancelled" });
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => ({ arrayBuffer: async () => new ArrayBuffer(8) }),
  });
  expect(
    await saveServerPdf({ fetch }, "/api/pdf-export/job/download", "x.pdf"),
  ).toBe(false);
  mocks.save.mockClear();
  const deniedBlob = vi.fn();
  fetch.mockResolvedValue({ ok: false, status: 403, blob: deniedBlob });
  await expect(
    saveServerPdf({ fetch }, "/api/pdf-export/job/download", "x.pdf"),
  ).rejects.toThrow(I18n.t("com.myoxus.pdf-export.dialog.error.failed"));
  expect(deniedBlob).not.toHaveBeenCalled();
  expect(mocks.save).not.toHaveBeenCalled();
});
