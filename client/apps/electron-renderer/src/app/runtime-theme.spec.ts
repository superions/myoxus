/** @vitest-environment happy-dom */
import { Storage } from "happy-dom";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createRuntimeThemeController,
  startThemeAutoReload,
} from "./runtime-theme";
import {
  getDesktopBridge,
  type DesktopBridge,
} from "@myoxus/desktop-api-contract/bridge";
import type { TabStatus } from "@myoxus/desktop-api-contract";

vi.mock("@myoxus/desktop-api-contract/bridge", () => ({
  getDesktopBridge: vi.fn(),
}));
vi.mock("@myoxus/ui-facade", () => ({
  applyBrandIdentityDocumentMetadata: vi.fn(async () => undefined),
  notifyBrandIdentityUpdated: vi.fn(),
  setBrandIdentityServerPath: vi.fn(),
}));

const workspaceId = "11111111-1111-4111-8111-111111111111";
const css =
  ':root { --myoxus-theme-slug: "hamburg"; --myoxus-accent-primary: #123456; }';
let controller: ReturnType<typeof createRuntimeThemeController>;
beforeEach(() => {
  document.head.innerHTML = "";
  // Node 26's host getter can shadow the DOM environment's storage. Install
  // browser Storage so the controller and assertions share the same owner.
  vi.stubGlobal("localStorage", new Storage());
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(css)),
  );
  controller = createRuntimeThemeController(document);
});
afterEach(() => {
  controller.dispose();
  vi.unstubAllGlobals();
});

test("an unconfigured controller selects fallback and never requests a server", () => {
  expect(document.documentElement.dataset.myoxusThemeSource).toBe(
    "electron-fallback",
  );
  expect(fetch).not.toHaveBeenCalled();
});

test.each([".", "another-host"])(
  "requests the exact server/workspace on bundled host %s, gives API CSS priority and persists only a scoped slug",
  async (host) => {
    vi.stubGlobal("location", { protocol: "assets:", host });
    await controller.update({ serverId: "alpha", workspaceId });
    expect(fetch).toHaveBeenCalledWith(
      `assets://${host}/_server/alpha/api/branding/theme.css?workspaceId=${workspaceId}`,
      expect.objectContaining({
        cache: "no-cache",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(controller.style.textContent).toContain(css);
    expect(controller.style.dataset.myoxusBrandingSource).toBe("api");
    expect(localStorage.length).toBe(1);
    expect(
      localStorage.getItem(`myoxus:electron-theme:alpha:${workspaceId}`),
    ).toBe("hamburg");
    expect(document.documentElement.dataset.myoxusTheme).toBeUndefined();
  },
);

test("clears foreign CSS immediately, cancels its request and ignores late replies", async () => {
  let resolveFirst!: (response: Response) => void;
  vi.mocked(fetch).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveFirst = resolve;
      }),
  );
  const first = controller.update({ serverId: "alpha", workspaceId });
  const firstSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
  const second = controller.update({ serverId: "beta", workspaceId });
  expect(firstSignal?.aborted).toBe(true);
  expect(controller.style.textContent).toBe("");
  await second;
  resolveFirst(new Response(css.replace("hamburg", "stuttgart")));
  await first;
  expect(controller.style.textContent).not.toContain("stuttgart");
  expect(
    localStorage.getItem(`myoxus:electron-theme:alpha:${workspaceId}`),
  ).toBeNull();
  await controller.update({ serverId: null });
  expect(controller.style.textContent).toBe("");
  expect(document.documentElement.dataset.myoxusTheme).toBeUndefined();
});

test("offline uses only the matching slug hint and never fetches or stores fallback CSS", async () => {
  await controller.update({ serverId: "alpha", workspaceId });
  vi.mocked(fetch).mockResolvedValue(new Response(null, { status: 503 }));
  await controller.reload();
  expect(controller.style.textContent).toBe("");
  expect(document.documentElement.dataset.myoxusTheme).toBe("hamburg");
  await controller.update({ serverId: "beta", workspaceId });
  expect(document.documentElement.dataset.myoxusTheme).toBeUndefined();
  expect(
    vi
      .mocked(fetch)
      .mock.calls.every(([url]) => String(url).includes("/_server/")),
  ).toBe(true);
  expect(localStorage.length).toBe(1);
});

test("server fonts retain the CSS owner while the global scope omits workspaceId", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response(
      css + '@font-face { src: url("/api/fonts/custom.woff2?v=1"); }',
    ),
  );
  await controller.update({ serverId: "beta" });
  expect(fetch).toHaveBeenCalledWith(
    "assets://./_server/beta/api/branding/theme.css",
    expect.anything(),
  );
  expect(controller.style.textContent).toContain(
    'url("assets://./_server/beta/api/fonts/custom.woff2?v=1")',
  );
});

test("persistent frames follow the active tab and ignore a stale initial IPC snapshot", async () => {
  let onStatus!: (tabs: TabStatus[]) => void;
  let initial!: (tabs: TabStatus[]) => void;
  const unsubscribe = vi.fn();
  vi.mocked(getDesktopBridge).mockReturnValue({
    appInfo: { viewId: "shell" },
    apis: {
      ui: {
        getTabsStatus: () =>
          new Promise((resolve) => {
            initial = resolve;
          }),
      },
    },
    events: {
      ui: {
        onBrandingUpdated: () => vi.fn(),
        onTabsStatusChange: (callback: typeof onStatus) => {
          onStatus = callback;
          return unsubscribe;
        },
      },
    },
  } as unknown as DesktopBridge);
  const tab = (serverId: string): TabStatus => ({
    id: serverId,
    serverId,
    basename: `/workspace/${workspaceId}`,
    views: [],
    activeViewIndex: 0,
    active: true,
    ready: true,
    loaded: true,
    pinned: false,
  });
  const stop = startThemeAutoReload("active");
  try {
    onStatus([tab("beta")]);
    await vi.waitFor(() =>
      expect(document.documentElement.dataset.myoxusThemeSource).toBe("api"),
    );
    initial([tab("alpha")]);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      `assets://./_server/beta/api/branding/theme.css?workspaceId=${workspaceId}`,
      expect.anything(),
    );
  } finally {
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
  }
});

test("Main invalidation reloads an already open popup only for its current server", async () => {
  let onStatus!: (tabs: TabStatus[]) => void;
  let onBranding!: (payload: { serverId: string }) => void;
  const remove = vi.fn();
  const invalidate = vi.fn();
  vi.mocked(getDesktopBridge).mockReturnValue({
    appInfo: { viewId: "popup" },
    apis: {
      ui: { getTabsStatus: async () => [], invalidateBranding: invalidate },
    },
    events: {
      ui: {
        onTabsStatusChange: (fn: typeof onStatus) => {
          onStatus = fn;
          return vi.fn();
        },
        onBrandingUpdated: (fn: typeof onBranding) => {
          onBranding = fn;
          return remove;
        },
      },
    },
  } as unknown as DesktopBridge);
  const stop = startThemeAutoReload("active");
  try {
    onStatus([
      {
        id: "view",
        serverId: "alpha",
        basename: `/workspace/${workspaceId}`,
        active: true,
      } as TabStatus,
    ]);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    onBranding({ serverId: "beta" });
    expect(fetch).toHaveBeenCalledTimes(1);
    onBranding({ serverId: "alpha" });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(invalidate).not.toHaveBeenCalled();
    onStatus([]);
    expect(document.documentElement.dataset.myoxusThemeSource).toBe(
      "electron-fallback",
    );
    onBranding({ serverId: "alpha" });
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    expect(remove).toHaveBeenCalledOnce();
  }
});
