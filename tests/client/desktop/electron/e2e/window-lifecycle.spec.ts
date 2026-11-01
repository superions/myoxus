// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { expect, test, type TestInfo } from "@playwright/test";

import {
  assertPackagedElectronClassification,
  classifyRuntimeEvents,
  closeElectron,
  launchPackagedElectron,
  type PackagedElectronRuntime,
  type PackagedRenderer,
  type PackagedWindowState,
  removeDirectory,
  type RuntimeEvent,
} from "../fixtures/packaged-runtime";
import { startLinuxUpdateFeedServer } from "../fixtures/update-feed-server";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const PHASE_OUTPUT = path.join(
  REPO_ROOT,
  "output/electron-build/P-ELECTRON-BUILD-04",
);
const PROFILE_ROOT = path.join(PHASE_OUTPUT, "profiles");
const RUNTIME_ROOT = path.join(PHASE_OUTPUT, "runtime");
const SCREENSHOT_ROOT = path.join(PHASE_OUTPUT, "screenshots");

const MAIN_VIEWPORT = { width: 1280, height: 800 } as const;
const MAXIMIZED_VIEWPORT = { width: 1440, height: 900 } as const;
const THEMES = ["light", "dark", "system"] as const;

type Theme = (typeof THEMES)[number];
type WindowState = "maximized" | "normal";

type CaptureRecord = {
  effectiveTheme: "dark" | "light";
  screenshot: string;
  sha256: string;
  state: WindowState;
  theme: Theme;
  url: string;
  viewport: { height: number; width: number };
  window: PackagedWindowState;
};

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function profileDirectory(testInfo: TestInfo, theme: Theme): string {
  const key = createHash("sha256")
    .update(testInfo.testId)
    .digest("hex")
    .slice(0, 12);
  return path.join(PROFILE_ROOT, `${theme}-${key}`);
}

async function removeFile(file: string): Promise<void> {
  await rm(file, { force: true });
}

async function prepareThemeOutput(
  profile: string,
  runtimeDirectory: string,
  theme: Theme,
): Promise<void> {
  await Promise.all([
    removeDirectory(profile),
    removeDirectory(`${profile}-normal`),
    removeDirectory(`${profile}-maximized`),
  ]);
  await removeDirectory(runtimeDirectory);
  await Promise.all(
    (["normal", "maximized"] as const).flatMap((state) => {
      const file = path.join(
        SCREENSHOT_ROOT,
        `${theme}-${state}-${state === "normal" ? "1280x800" : "1440x900"}.png`,
      );
      return [
        removeFile(file),
        removeFile(file.replace(/\.png$/, ".repeat.png")),
      ];
    }),
  );
  await mkdir(SCREENSHOT_ROOT, { recursive: true });
}

async function seedMainWindowState(
  profile: string,
  state: WindowState,
): Promise<void> {
  const file = path.join(profile, "global-state.json");
  let persisted: Record<string, unknown> = {};
  try {
    persisted = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const viewport = state === "normal" ? MAIN_VIEWPORT : MAXIMIZED_VIEWPORT;
  persisted.mainWindowState = {
    bounds: {
      height: viewport.height,
      width: viewport.width,
      x: state === "normal" ? 80 : 0,
      y: state === "normal" ? 50 : 0,
    },
    isFullScreen: false,
    isMaximized: state === "maximized",
  };
  await writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function setTheme(
  page: PackagedRenderer,
  theme: Theme,
): Promise<"dark" | "light"> {
  await page.evaluate(async (requestedTheme) => {
    const api = (
      window as Window & {
        __apis?: {
          ui?: {
            handleThemeChange?: (
              theme: "dark" | "light" | "system",
            ) => Promise<void>;
          };
        };
      }
    ).__apis?.ui;
    if (!api?.handleThemeChange) {
      throw new Error("Desktop theme IPC is unavailable");
    }
    await api.handleThemeChange(requestedTheme);
  }, theme);
  await page.emulateColorScheme(theme === "system" ? null : theme);

  let effectiveTheme: "dark" | "light" = "light";
  await expect
    .poll(async () => {
      effectiveTheme = await page.evaluate(() =>
        matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
      );
      return theme === "system" || effectiveTheme === theme;
    })
    .toBe(true);
  return effectiveTheme;
}

async function stabilizeRenderer(page: PackagedRenderer): Promise<void> {
  await page.evaluate(async () => {
    const style = document.createElement("style");
    style.dataset.releaseSmoke = "stability";
    style.textContent =
      "*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;caret-color:transparent!important;transition:none!important}";
    document.head.append(style);
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
}

async function captureWindow(
  runtime: PackagedElectronRuntime,
  theme: Theme,
  effectiveTheme: "dark" | "light",
  state: WindowState,
): Promise<CaptureRecord> {
  const viewport = state === "normal" ? MAIN_VIEWPORT : MAXIMIZED_VIEWPORT;
  const window = await runtime.page.evaluate(async (requestedState) => {
    const api = (
      globalThis as typeof globalThis & {
        __apis?: {
          ui?: { isMaximized?: () => Promise<boolean | undefined> };
        };
      }
    ).__apis?.ui;
    if (!api?.isMaximized) {
      throw new Error("Desktop window-state IPC is unavailable");
    }
    const isMaximized = (await api.isMaximized()) === true;
    return {
      bounds: {
        height: outerHeight,
        left: screenX,
        top: screenY,
        width: outerWidth,
        windowState: isMaximized ? "maximized" : "normal",
      },
      isMaximized,
      maximizationMode:
        requestedState === "maximized" && !isMaximized
          ? ("work-area-fallback" as const)
          : ("native" as const),
    };
  }, state);
  if (state === "normal") {
    expect(window.isMaximized).toBe(false);
    expect(window.bounds.windowState).toBe("normal");
  } else {
    expect(
      window.isMaximized || window.maximizationMode === "work-area-fallback",
    ).toBe(true);
    expect(window.bounds.width).toBeGreaterThanOrEqual(1200);
    expect(window.bounds.height).toBeGreaterThanOrEqual(700);
  }

  await stabilizeRenderer(runtime.page);
  let screenshot = await runtime.page.captureScreenshot();
  let screenshotHash = sha256(screenshot);
  let repeated = screenshot;
  let repeatedHash = screenshotHash;
  let stable = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(250);
    repeated = await runtime.page.captureScreenshot();
    repeatedHash = sha256(repeated);
    if (screenshotHash === repeatedHash) {
      stable = true;
      break;
    }
    screenshot = repeated;
    screenshotHash = repeatedHash;
  }

  const relativeScreenshot = path.join(
    "screenshots",
    `${theme}-${state}-${viewport.width}x${viewport.height}.png`,
  );
  const screenshotPath = path.join(PHASE_OUTPUT, relativeScreenshot);
  await writeFile(screenshotPath, screenshot);
  expect(
    screenshot.byteLength,
    "Electron screenshot is unexpectedly empty",
  ).toBeGreaterThan(20_000);
  if (!stable) {
    await writeFile(screenshotPath.replace(/\.png$/, ".repeat.png"), repeated);
    throw new Error(
      `Non-deterministic Electron screenshot for ${theme}/${state}: ${screenshotHash} != ${repeatedHash}`,
    );
  }

  const rendererViewport = await runtime.page.evaluate(() => ({
    height: innerHeight,
    width: innerWidth,
  }));
  expect(rendererViewport.width).toBeGreaterThan(0);
  expect(rendererViewport.height).toBeGreaterThan(0);
  return {
    effectiveTheme,
    screenshot: relativeScreenshot,
    sha256: screenshotHash,
    state,
    theme,
    url: runtime.page.url,
    viewport: rendererViewport,
    window,
  };
}

async function writeWindowEvidence(
  theme: Theme,
  evidence: Record<string, unknown>,
  events: readonly RuntimeEvent[],
  stderr: readonly string[],
  stdout: readonly string[],
): Promise<void> {
  const directory = path.join(RUNTIME_ROOT, theme);
  await mkdir(directory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(directory, "runtime.json"),
      `${JSON.stringify(evidence, null, 2)}\n`,
    ),
    writeFile(path.join(directory, "main.stderr.log"), stderr.join("")),
    writeFile(path.join(directory, "main.stdout.log"), stdout.join("")),
    writeFile(
      path.join(directory, "renderer-events.jsonl"),
      events.length > 0
        ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n`
        : "",
    ),
  ]);
}

test.describe("packaged Electron 44 window lifecycle", () => {
  test.describe.configure({ mode: "serial" });

  for (const theme of THEMES) {
    test(`${theme}: normal and maximized product window`, async ({
      browserName: _browserName,
    }, testInfo) => {
      const profile = profileDirectory(testInfo, theme);
      const runtimeDirectory = path.join(RUNTIME_ROOT, theme);
      await prepareThemeOutput(profile, runtimeDirectory, theme);
      let runtime: PackagedElectronRuntime | undefined;
      const evidence: Record<string, unknown> = {
        captures: [],
        profileDirectory: path.relative(PHASE_OUTPUT, profile),
        requestedTheme: theme,
      };
      const events: RuntimeEvent[] = [];
      const stderr: string[] = [];
      const stdout: string[] = [];

      try {
        const captures: CaptureRecord[] = [];
        const launches: Record<string, unknown>[] = [];
        for (const state of ["normal", "maximized"] as const) {
          const stateProfile = `${profile}-${state}`;
          await mkdir(stateProfile, { recursive: true });
          await seedMainWindowState(stateProfile, state);
          runtime = await launchPackagedElectron(stateProfile);
          await assertPackagedElectronClassification(runtime);
          const effectiveTheme = await setTheme(runtime.page, theme);
          launches.push({
            main: runtime.main,
            renderer: runtime.renderer,
            shell: runtime.shell,
            state,
          });
          captures.push(
            await captureWindow(runtime, theme, effectiveTheme, state),
          );
          events.push(...runtime.events);
          stderr.push(...runtime.stderr);
          stdout.push(...runtime.stdout);
          await closeElectron(runtime);
          runtime = undefined;
        }
        evidence.captures = captures;
        evidence.launches = launches;
        const classified = classifyRuntimeEvents(events);
        evidence.expectedOffline = classified.expectedOffline;
        evidence.unexpected = classified.unexpected;
        expect(
          classified.unexpected,
          "packaged Electron window emitted unexpected renderer errors",
        ).toEqual([]);
      } finally {
        if (runtime) await closeElectron(runtime);
        await writeWindowEvidence(theme, evidence, events, stderr, stdout);
        await Promise.all([
          removeDirectory(profile),
          removeDirectory(`${profile}-normal`),
          removeDirectory(`${profile}-maximized`),
        ]);
      }
    });
  }
});

test.describe("packaged Linux updater lifecycle", () => {
  test("downloads and verifies the selected DEB update", async () => {
    expect(process.platform).toBe("linux");
    expect(process.arch).toBe("x64");

    const profile = path.join(PROFILE_ROOT, "linux-updater");
    const fixture = await startLinuxUpdateFeedServer();
    await removeDirectory(profile);
    await mkdir(profile, { recursive: true });

    const previousArguments = process.env.MYOXUS_ELECTRON_LAUNCH_ARGUMENTS;
    const previousCache = process.env.XDG_CACHE_HOME;
    const launchArguments = previousArguments
      ? (JSON.parse(previousArguments) as string[])
      : [];
    process.env.MYOXUS_ELECTRON_LAUNCH_ARGUMENTS = JSON.stringify([
      ...launchArguments,
      `--ignore-certificate-errors-spki-list=${fixture.certificateSpkiSha256}`,
    ]);
    process.env.XDG_CACHE_HOME = path.join(profile, "cache");

    let runtime: PackagedElectronRuntime | undefined;
    try {
      runtime = await launchPackagedElectron(profile);
      await assertPackagedElectronClassification(runtime);
      const packageType = (
        await readFile(
          path.join(runtime.main.packageResourcesPath, "package-type"),
          "utf8",
        )
      ).trim();
      const result = await runtime.page.evaluate(async (expectedVersion) => {
        type UpdateMeta = { allowAutoUpdate: boolean; version: string };
        type UpdaterApi = {
          checkForUpdates: () => Promise<{ version: string } | null>;
          downloadUpdate: () => Promise<void>;
          setConfig: (config: {
            autoCheckUpdate: boolean;
            autoDownloadUpdate: boolean;
          }) => Promise<void>;
        };
        type UpdaterEvents = {
          onDownloadProgress: (
            callback: (progress: number) => void,
          ) => () => void;
          onUpdateAvailable: (
            callback: (meta: UpdateMeta) => void,
          ) => () => void;
          onUpdateReady: (callback: (meta: UpdateMeta) => void) => () => void;
        };
        const desktopWindow = window as Window & {
          __apis?: { updater?: UpdaterApi };
          __events?: { updater?: UpdaterEvents };
        };
        const api = desktopWindow.__apis?.updater;
        const events = desktopWindow.__events?.updater;
        if (!api || !events) {
          throw new Error("Desktop updater IPC is unavailable");
        }

        const progress: number[] = [];
        const available: UpdateMeta[] = [];
        const ready: UpdateMeta[] = [];
        const unsubscribe = [
          events.onDownloadProgress((value) => progress.push(value)),
          events.onUpdateAvailable((value) => available.push(value)),
          events.onUpdateReady((value) => ready.push(value)),
        ];
        try {
          await api.setConfig({
            autoCheckUpdate: false,
            autoDownloadUpdate: false,
          });
          const checked = await api.checkForUpdates();
          await api.downloadUpdate();
          const deadline = Date.now() + 15_000;
          while (ready.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          return { available, checked, progress, ready, expectedVersion };
        } finally {
          unsubscribe.forEach((dispose) => dispose());
        }
      }, fixture.version);

      const serverEvidence = fixture.evidence();
      await mkdir(RUNTIME_ROOT, { recursive: true });
      await writeFile(
        path.join(RUNTIME_ROOT, "linux-updater.json"),
        `${JSON.stringify(
          {
            artifactName: fixture.artifactName,
            packageType,
            renderer: result,
            runtime: runtime.main,
            server: serverEvidence,
          },
          null,
          2,
        )}\n`,
      );
      expect(packageType).toBe("deb");
      expect(result.checked).toEqual({ version: fixture.version });
      expect(result.available.at(-1)).toEqual({
        allowAutoUpdate: true,
        version: fixture.version,
      });
      expect(result.progress[0]).toBe(0);
      expect(result.progress.some((value) => value > 0 && value < 100)).toBe(
        true,
      );
      expect(result.progress.at(-1)).toBeCloseTo(100, 3);
      expect(result.ready.at(-1)).toEqual({
        allowAutoUpdate: true,
        version: fixture.version,
      });
      expect(serverEvidence).toMatchObject({
        artifactRequests: 1,
        manifestRequests: 1,
        releaseRequests: 1,
      });
      expect(serverEvidence.bytesServed).toBe(fixture.artifactSize);
      expect(classifyRuntimeEvents(runtime.events).unexpected).toEqual([]);
    } finally {
      if (runtime) await closeElectron(runtime);
      await fixture.close();
      if (previousArguments === undefined) {
        delete process.env.MYOXUS_ELECTRON_LAUNCH_ARGUMENTS;
      } else {
        process.env.MYOXUS_ELECTRON_LAUNCH_ARGUMENTS = previousArguments;
      }
      if (previousCache === undefined) {
        delete process.env.XDG_CACHE_HOME;
      } else {
        process.env.XDG_CACHE_HOME = previousCache;
      }
      await removeDirectory(profile);
    }
  });
});
