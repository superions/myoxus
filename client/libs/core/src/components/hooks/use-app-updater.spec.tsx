// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import type { UpdaterState } from "@myoxus/desktop-api-contract";
import { Storage } from "happy-dom";
import { createStore, Provider } from "jotai";
import { Suspense, type PropsWithChildren } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  state: null as UpdaterState | null,
  listener: null as ((state: UpdaterState) => void) | null,
  updater: {
    getState: vi.fn(),
    currentVersion: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
  urls: { openExternal: vi.fn(), openPopupWindow: vi.fn() },
  notifyError: vi.fn(),
}));
vi.mock("@myoxus/desktop-api-contract/bridge", () => ({
  getDesktopBridge: () => ({
    apis: { updater: runtime.updater },
    events: {
      updater: {
        onStateChange: (listener: (state: UpdaterState) => void) => {
          runtime.listener = listener;
          return () => {
            if (runtime.listener === listener) runtime.listener = null;
          };
        },
      },
    },
  }),
}));
vi.mock("@myoxus/core/modules/url", () => ({ UrlService: {} }));
vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  // Version/changelog Suspense belongs to separate consumers. Preserve the
  // real observable updater atoms and React state while fixing those inputs.
  const unrelatedAsync = (value: any) =>
    value.read?.constructor.name === "AsyncFunction";
  const version = actual.atom("9000.0.0");
  const changelog = actual.atom(false);
  return {
    ...actual,
    useAtomValue: (value: any, options: any) =>
      actual.useAtomValue(unrelatedAsync(value) ? version : value, options),
    useAtom: (value: any, options: any) =>
      actual.useAtom(unrelatedAsync(value) ? changelog : value, options),
  };
});
vi.mock("@myoxus/infra", async () => ({
  deviceSettingAtom: (await import("jotai")).atom({
    autoCheckUpdate: true,
    autoDownloadUpdate: true,
  }),
  useService: () => runtime.urls,
}));
vi.mock("@myoxus/track", () => ({
  track: {
    $: {
      navigationPanel: {
        bottomButtons: {
          quitAndInstall: vi.fn(),
          openChangelog: vi.fn(),
          dismissChangelog: vi.fn(),
        },
      },
      settingsPanel: {
        about: {
          checkUpdates: vi.fn(),
          downloadUpdate: vi.fn(),
          changeAppSetting: vi.fn(),
        },
      },
    },
  },
}));
vi.mock("@myoxus/i18n", () => ({
  useI18n: () => new Proxy({}, { get: (_, key) => () => String(key) }),
}));
vi.mock("@myoxus/icons/react", () => ({
  DownloadIcon: () => null,
  CloseIcon: () => null,
  NewIcon: () => null,
  ResetIcon: () => null,
}));
vi.mock("@myoxus/core/desktop/dialogs/setting/primitives", () => ({
  SettingsRow: ({ name, desc, children }: any) => (
    <section>
      {name}
      {desc}
      {children}
    </section>
  ),
  SettingsStatusText: ({ children }: any) => <span>{children}</span>,
  MyoxusLoader: () => <span role="status" />,
  MyoxusButton: ({ children, ...props }: any) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("@myoxus/core/modules/app-sidebar/views", async () => ({
  AppUpdaterButton: (
    await import("@myoxus/core/modules/app-sidebar/views/app-updater-button")
  ).AppUpdaterButton,
}));
// Keep both actual Core projections; only their visual primitive rendering
// is substituted. These are interaction/state contracts, not visual evidence.
vi.mock("@myoxus/ui-facade", () => ({
  notify: { error: runtime.notifyError },
  Tooltip: ({ children }: any) => children,
  SidebarNavItem: ({ label, onClick }: any) => (
    <button onClick={onClick}>{label}</button>
  ),
  IconButton: (props: any) => (
    <button aria-label={props["aria-label"]} onClick={props.onClick} />
  ),
  SidebarPromoAction: ({ label, disabled, onClick, progressValue }: any) => (
    <>
      <button disabled={disabled} onClick={onClick}>
        {label}
      </button>
      {progressValue != null ? (
        <progress value={progressValue} max={100} />
      ) : null}
    </>
  ),
}));

import { useAppUpdater } from "@myoxus/core/components/hooks/use-app-updater";
import { UpdaterButton } from "@myoxus/core/components/root-app-sidebar/updater-button";
import { UpdateCheckSection } from "@myoxus/core/desktop/dialogs/setting/general-setting/about/update-check-section";

const meta = { allowAutoUpdate: true, version: "9000.0.1" };
const idle: UpdaterState = {
  availability: { state: "enabled" },
  phase: "idle",
  available: null,
  ready: null,
  progress: null,
};
function wrapper() {
  const store = createStore();
  return ({ children }: PropsWithChildren) => (
    <Provider store={store}>
      <Suspense fallback={null}>{children}</Suspense>
    </Provider>
  );
}
function publish(state: UpdaterState) {
  act(() => {
    runtime.listener!(state);
  });
}
beforeEach(() => {
  vi.stubGlobal("BUILD_CONFIG", {
    isElectron: true,
    downloadUrl: "https://example.invalid/downloads",
    changelogUrl: "https://example.invalid/changelog",
  });
  vi.stubGlobal("localStorage", new Storage());
  localStorage.setItem(
    "myoxus:client-changelog-checked",
    JSON.stringify({ "9000.0.0": true }),
  );
  vi.clearAllMocks();
  runtime.state = idle;
  runtime.listener = null;
  runtime.updater.getState.mockImplementation(async () => runtime.state);
  runtime.updater.currentVersion.mockResolvedValue("9000.0.0");
  runtime.updater.checkForUpdates.mockResolvedValue({
    state: "checked",
    version: null,
  });
  runtime.updater.downloadUpdate.mockResolvedValue(undefined);
  runtime.updater.quitAndInstall.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("restart failure or canceled admission releases the renderer so retry stays usable", async () => {
  runtime.state = { ...idle, phase: "ready", available: meta, ready: meta };
  let reject!: (error: Error) => void;
  runtime.updater.quitAndInstall.mockReturnValueOnce(
    new Promise<void>((_, fail) => {
      reject = fail;
    }),
  );
  const report = vi.spyOn(console, "error").mockImplementation(() => {});
  const { result } = renderHook(() => useAppUpdater(), { wrapper: wrapper() });
  await waitFor(() => expect(result.current?.updateReady).toEqual(meta));
  act(() => result.current.quitAndInstall());
  expect(result.current.appQuitting).toBe(true);
  const failure = new Error("fixture IPC rejection");
  act(() => reject(failure));
  await waitFor(() => expect(result.current.appQuitting).toBe(false));
  expect(report).toHaveBeenCalledWith(failure);
  expect(runtime.notifyError).toHaveBeenCalledWith({
    title: "com.myoxus.common.operation-failed",
  });
  act(() => result.current.quitAndInstall());
  await waitFor(() => expect(result.current.appQuitting).toBe(false));
  expect(runtime.updater.quitAndInstall).toHaveBeenCalledTimes(2);
});

test("About and sidebar consume Main retry, progress, ready and external availability states", async () => {
  runtime.state = { ...idle, phase: "checking" };
  render(
    <>
      <UpdateCheckSection />
      <UpdaterButton />
    </>,
    { wrapper: wrapper() },
  );
  const about = await screen.findByTestId("check-update-button");
  expect(about.hasAttribute("disabled")).toBe(true);
  publish({ ...idle, phase: "latest" });
  expect(about.textContent).toContain("button.retry");
  fireEvent.click(about);
  await waitFor(() =>
    expect(runtime.updater.checkForUpdates).toHaveBeenCalledOnce(),
  );
  publish({ ...idle, phase: "error", available: meta });
  expect(screen.getByText("com.myoxus.common.operation-failed")).toBeTruthy();
  fireEvent.click(about);
  expect(runtime.updater.downloadUpdate).toHaveBeenCalledOnce();
  publish({ ...idle, phase: "downloading", available: meta, progress: 49 });
  expect(about.hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("49");
  const sidebarDownload = screen.getByRole("button", {
    name: "com.myoxus.appUpdater.downloading",
  });
  expect(sidebarDownload.hasAttribute("disabled")).toBe(true);
  publish({ ...idle, phase: "ready", available: meta, ready: meta });
  fireEvent.click(
    screen.getByRole("button", {
      name: "com.myoxus.appUpdater.updateAvailable",
    }),
  );
  await waitFor(() =>
    expect(runtime.updater.quitAndInstall).toHaveBeenCalledOnce(),
  );
  publish({ ...idle, availability: { state: "disabled", reason: "portable" } });
  expect(about.hasAttribute("disabled")).toBe(true);
  expect(
    screen.getByText("com.myoxus.aboutMyoxus.checkUpdate.subtitle.portable"),
  ).toBeTruthy();
  expect(
    screen.queryByRole("button", {
      name: "com.myoxus.appUpdater.updateAvailable",
    }),
  ).toBeNull();
  publish({
    ...idle,
    availability: { state: "disabled", reason: "external-macos-install" },
  });
  fireEvent.click(
    screen.getAllByRole("button", {
      name: "com.myoxus.appUpdater.openDownloadPage",
    })[0],
  );
  expect(runtime.urls.openExternal).toHaveBeenCalledWith(
    "https://example.invalid/downloads",
  );
  expect(runtime.updater.checkForUpdates).toHaveBeenCalledOnce();
  expect(runtime.updater.downloadUpdate).toHaveBeenCalledOnce();
});
