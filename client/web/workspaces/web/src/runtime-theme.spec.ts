/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  ensureRuntimeThemeProjection,
  getBrandingThemeCssHref,
  getRuntimeWorkspaceIdFromPathname,
  startThemeAutoReload,
} from "./runtime-theme";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  history.pushState(null, "", "/");
  document.head.innerHTML = "";
  delete document.documentElement.dataset.myoxusThemeSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () =>
        Promise.resolve(
          ':root { --myoxus-theme-slug: "stuttgart"; --myoxus-accent-primary: #123456; }',
        ),
    }),
  );
  vi.spyOn(console, "debug").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("browser Web runtime theme projection", () => {
  test("loads only the live workspace-scoped server projection", async () => {
    history.pushState(null, "", `/workspace/${WORKSPACE_ID}/all`);
    const style = ensureRuntimeThemeProjection(document, "/myoxus");

    await vi.waitFor(() => {
      expect(style.dataset.myoxusBrandingSource).toBe("api");
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `/myoxus/api/branding/theme.css?workspaceId=${WORKSPACE_ID}`,
      { cache: "no-cache" },
    );
    expect(style.textContent).toContain("--myoxus-accent-primary");
    expect(document.documentElement.dataset.myoxusThemeSource).toBe("api");
  });

  test("clears stale CSS and never requests the Electron fallback", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: () => Promise.resolve(":root { --myoxus-stale: 1; }"),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: () => Promise.resolve(""),
      } as Response);

    const style = ensureRuntimeThemeProjection(document, "/myoxus");
    await vi.waitFor(() => expect(style.textContent).toContain("stale"));
    ensureRuntimeThemeProjection(document, "/myoxus");

    await vi.waitFor(() => {
      expect(style.dataset.myoxusBrandingSource).toBe("unavailable");
    });
    expect(style.textContent).toBe("");
    expect(document.documentElement.dataset.myoxusThemeSource).toBe(
      "unavailable",
    );
    expect(vi.mocked(fetch).mock.calls).toHaveLength(2);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([url]) => String(url).includes("theme-fallback")),
    ).toBe(false);
  });

  test("re-evaluates workspace scope after SPA navigation", async () => {
    const cleanup = startThemeAutoReload();
    try {
      history.pushState(null, "", `/workspace/${WORKSPACE_ID}/all`);
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledWith(
          `/api/branding/theme.css?workspaceId=${WORKSPACE_ID}`,
          { cache: "no-cache" },
        );
      });
    } finally {
      cleanup();
    }
  });

  test("keeps route parsing and request construction strict", () => {
    expect(
      getRuntimeWorkspaceIdFromPathname(`/share/${WORKSPACE_ID}/doc`),
    ).toBe(WORKSPACE_ID);
    expect(
      getRuntimeWorkspaceIdFromPathname("/workspace/not-a-uuid/all"),
    ).toBeNull();
    expect(getBrandingThemeCssHref("/myoxus/", null)).toBe(
      "/myoxus/api/branding/theme.css",
    );
  });
});
