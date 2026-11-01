/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchBrandingThemeCss: vi.fn(),
}));

vi.mock("./api/runtime-status-api", () => ({
  fetchBrandingThemeCss: mocks.fetchBrandingThemeCss,
}));

import {
  ensureRuntimeThemeProjection,
  reloadRuntimeTheme,
} from "./runtime-theme";

beforeEach(() => {
  document.head.innerHTML = "";
  delete document.documentElement.dataset.myoxusThemeSource;
  mocks.fetchBrandingThemeCss.mockResolvedValue(
    ":root { --myoxus-accent-primary: #123456; }",
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Admin runtime theme projection", () => {
  test("uses the live server projection without a static stylesheet layer", async () => {
    const style = ensureRuntimeThemeProjection(document, "/adminfrontend");

    await vi.waitFor(() => {
      expect(style.dataset.myoxusBrandingSource).toBe("api");
    });
    expect(mocks.fetchBrandingThemeCss).toHaveBeenCalledWith("/adminfrontend");
    expect(document.querySelectorAll("link[rel=stylesheet]")).toHaveLength(0);
  });

  test("clears stale server CSS instead of loading an offline fallback", async () => {
    const style = ensureRuntimeThemeProjection(document, "/adminfrontend");
    await vi.waitFor(() => expect(style.textContent).toContain("#123456"));

    mocks.fetchBrandingThemeCss.mockResolvedValueOnce(null);
    reloadRuntimeTheme(document, "/adminfrontend");

    await vi.waitFor(() => {
      expect(style.dataset.myoxusBrandingSource).toBe("unavailable");
    });
    expect(style.textContent).toBe("");
    expect(document.documentElement.dataset.myoxusThemeSource).toBe(
      "unavailable",
    );
  });
});
