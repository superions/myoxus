import { beforeEach, describe, expect, test, vi } from "vitest";

const changeLanguage = vi.fn();

vi.mock("@myoxus/i18n", () => ({
  I18n: { changeLanguage },
}));
vi.mock("electron", () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }));
vi.mock("../../src/main/clipboard", () => ({ clipboardHandlers: {} }));
vi.mock("../../src/main/find-in-page", () => ({ findInPageHandlers: {} }));
vi.mock("../../src/main/logger", () => ({
  getLogFilePath: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn() },
  revealLogFile: vi.fn(),
}));
vi.mock("../../src/main/recording", () => ({ recordingHandlers: {} }));
vi.mock("../../src/main/shared-storage", () => ({ sharedStorageHandlers: {} }));
vi.mock("../../src/main/ui/handlers", () => ({ uiHandlers: {} }));
vi.mock("../../src/main/updater", () => ({ updaterHandlers: {} }));
vi.mock("../../src/main/windows-manager/popup", () => ({ popupHandlers: {} }));
vi.mock("../../src/main/worker/handlers", () => ({ workerHandlers: {} }));

describe("main IPC handlers", () => {
  beforeEach(() => {
    changeLanguage.mockReset();
  });

  test("does not return i18next's non-cloneable translation function", async () => {
    const translationFunction = () => "translated";
    changeLanguage.mockResolvedValue(translationFunction);
    const { i18nHandlers } = await import("../../src/main/handlers");

    const result = await i18nHandlers.changeLanguage({} as never, "de");

    expect(changeLanguage).toHaveBeenCalledWith("de");
    expect(result).toBeUndefined();
    expect(() => structuredClone(result)).not.toThrow();
  });
});
