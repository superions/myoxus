// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test, vi } from "vitest";

const opener = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("electron", () => ({ shell: { openExternal: opener } }));

test("external URL policy rejects unsafe input and propagates OS failure without retaining the URL", async () => {
  // The Electron suite shares its module cache. Reload this consumer so its
  // electron binding cannot retain another spec's shell mock/implementation.
  vi.resetModules();
  opener.mockReset().mockResolvedValue(undefined);
  const { openExternalSafely } =
    await import("../../src/main/security/open-external");
  for (const url of ["javascript:alert(1)", "file:///private", "not a URL"]) {
    await expect(openExternalSafely(url)).rejects.toThrow("not allowed");
  }
  expect(opener).not.toHaveBeenCalled();
  const url = "https://example.test/download?token=private";
  opener.mockRejectedValueOnce(new Error(`OS error containing ${url}`));
  await expect(openExternalSafely(url)).rejects.toThrow(
    /^The system could not open the external URL$/,
  );
  await openExternalSafely("https://example.test/download");
  expect(opener).toHaveBeenLastCalledWith("https://example.test/download");
});
