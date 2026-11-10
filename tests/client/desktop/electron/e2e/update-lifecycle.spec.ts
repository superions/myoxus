// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ClientHandler,
  UpdateInfo,
  UpdaterState,
} from "@myoxus/desktop-api-contract";
import { expect, test } from "@playwright/test";
import {
  _electron as electron,
  type ElectronApplication,
  type Page,
} from "playwright";

import { startRealUpdateFeedServer } from "../fixtures/update-feed-server";

type Backend = "deb" | "flatpak" | "homebrew" | "nsis" | "rpm" | "zip";
type Phase =
  | "external-after"
  | "external-before"
  | "external-adopted"
  | "update"
  | "verify";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const backend = required("MYOXUS_UPDATE_E2E_BACKEND") as Backend;
const phase = required("MYOXUS_UPDATE_E2E_PHASE") as Phase;
const executablePath = required("MYOXUS_UPDATE_E2E_EXECUTABLE");
const channel = required("MYOXUS_UPDATE_E2E_CHANNEL") as
  "beta" | "internal" | "stable";
const sourceVersion = required("MYOXUS_UPDATE_E2E_SOURCE_VERSION");
const targetVersion = required("MYOXUS_UPDATE_E2E_TARGET_VERSION");
const profile = required("MYOXUS_UPDATE_E2E_PROFILE");
const evidenceDirectory = required("MYOXUS_UPDATE_E2E_EVIDENCE");
const artifactPath = process.env.MYOXUS_UPDATE_E2E_ARTIFACT?.trim();
const feedPort = Number(process.env.MYOXUS_UPDATE_E2E_FEED_PORT);
const expectedFlatpakId = {
  beta: "org.myoxus.beta",
  internal: "org.myoxus.internal",
  stable: "org.myoxus.desktop",
}[channel];

if (
  !["deb", "flatpak", "homebrew", "nsis", "rpm", "zip"].includes(backend) ||
  ![
    "external-after",
    "external-before",
    "external-adopted",
    "update",
    "verify",
  ].includes(phase) ||
  !["beta", "internal", "stable"].includes(channel)
) {
  throw new Error("Invalid Electron update E2E environment contract");
}

type UpdateApi = {
  checkForUpdates: () => Promise<UpdateInfo>;
  getState: () => Promise<UpdaterState>;
  currentVersion: () => Promise<string>;
  downloadLifecycle: (expectedVersion: string) => Promise<{
    available: { allowAutoUpdate: boolean; version: string }[];
    checked: UpdateInfo;
    progress: number[];
    ready: { allowAutoUpdate: boolean; version: string }[];
  }>;
  quitAndInstall: () => Promise<void>;
};

async function launch(
  certificateSpkiSha256?: string,
): Promise<{ app: ElectronApplication; api: UpdateApi; page: Page }> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete environment.ELECTRON_E2E;
  delete environment.ELECTRON_E2E_PACKAGE_TYPE;
  delete environment.ELECTRON_E2E_UPDATE_FEED;
  // The CI workflow may build several channels under a stable host default.
  // Exercise the packaged channel and explicit fixture profile, not that default.
  delete environment.BUILD_TYPE;
  environment.NODE_ENV = "production";
  const app = await electron.launch({
    chromiumSandbox: process.platform === "linux",
    args: [
      `--user-data-dir=${profile}`,
      "--no-first-run",
      ...(certificateSpkiSha256
        ? [`--ignore-certificate-errors-spki-list=${certificateSpkiSha256}`]
        : []),
    ],
    cwd: path.dirname(executablePath),
    env: environment,
    executablePath,
    locale: "en-US",
    timeout: 60_000,
  });
  // Keep Main/updater failures visible even if activation never reaches the
  // final evidence write. This process uses only the task-owned fixture profile.
  for (const output of [app.process().stdout, app.process().stderr]) {
    output?.on("data", (chunk) =>
      process.stdout.write(`[electron ${backend}/${phase}] ${chunk}`),
    );
  }
  const page = await app.firstWindow({ timeout: 60_000 });
  const api = await page.evaluate(() => {
    const desktopWindow = globalThis as typeof globalThis & {
      __apis?: { updater?: UpdateApi };
    };
    if (!desktopWindow.__apis?.updater) {
      throw new Error("Packaged Electron updater IPC is unavailable");
    }
    return true;
  });
  expect(api).toBe(true);
  return {
    app,
    page,
    api: {
      checkForUpdates: () =>
        page.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __apis: { updater: UpdateApi };
            }
          ).__apis.updater.checkForUpdates(),
        ),
      getState: () =>
        page.evaluate(() =>
          (
            globalThis as typeof globalThis & { __apis: { updater: UpdateApi } }
          ).__apis.updater.getState(),
        ),
      currentVersion: () =>
        page.evaluate(() =>
          (
            globalThis as typeof globalThis & {
              __apis: { updater: UpdateApi };
            }
          ).__apis.updater.currentVersion(),
        ),
      downloadLifecycle: (expectedVersion) =>
        page.evaluate(async (targetVersion) => {
          type UpdateMeta = { allowAutoUpdate: boolean; version: string };
          type RuntimeUpdaterApi = {
            checkForUpdates: () => Promise<UpdateInfo>;
            downloadUpdate: () => Promise<void>;
            setConfig: (config: {
              autoCheckUpdate: boolean;
              autoDownloadUpdate: boolean;
            }) => Promise<void>;
          };
          type RuntimeUpdaterEvents = {
            onDownloadProgress: (
              callback: (progress: number | null) => void,
            ) => () => void;
            onUpdateAvailable: (
              callback: (meta: UpdateMeta | null) => void,
            ) => () => void;
            onUpdateReady: (
              callback: (meta: UpdateMeta | null) => void,
            ) => () => void;
          };
          const desktopWindow = globalThis as typeof globalThis & {
            __apis: { updater: RuntimeUpdaterApi };
            __events?: { updater?: RuntimeUpdaterEvents };
          };
          const events = desktopWindow.__events?.updater;
          if (!events)
            throw new Error("Packaged updater events are unavailable");
          const progress: number[] = [];
          const available: UpdateMeta[] = [];
          const ready: UpdateMeta[] = [];
          const dispose = [
            events.onDownloadProgress((value) => {
              if (value !== null) progress.push(value);
            }),
            events.onUpdateAvailable((value) => {
              if (value) available.push(value);
            }),
            events.onUpdateReady((value) => {
              if (value) ready.push(value);
            }),
          ];
          try {
            await desktopWindow.__apis.updater.setConfig({
              autoCheckUpdate: false,
              autoDownloadUpdate: false,
            });
            const checked =
              await desktopWindow.__apis.updater.checkForUpdates();
            await desktopWindow.__apis.updater.downloadUpdate();
            const deadline = Date.now() + 30_000;
            while (
              ready.at(-1)?.version !== targetVersion &&
              Date.now() < deadline
            ) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return { available, checked, progress, ready };
          } finally {
            dispose.forEach((unsubscribe) => unsubscribe());
          }
        }, expectedVersion),
      quitAndInstall: () =>
        page.evaluate(() => {
          void (
            globalThis as typeof globalThis & {
              __apis: { updater: UpdateApi };
            }
          ).__apis.updater.quitAndInstall();
        }),
    },
  };
}

async function writeEvidence(value: unknown): Promise<void> {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    path.join(evidenceDirectory, `${channel}-${backend}-${phase}.json`),
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function assertProfileMarker(page: Page, initialize = false) {
  const marker = `${channel}:${sourceVersion}->${targetVersion}`;
  const actual = await page.evaluate(
    async ({ marker, initialize }) => {
      const api = (window as unknown as Window & { __apis: ClientHandler })
        .__apis.sharedStorage;
      if (initialize)
        await api.setGlobalState(
          "updateLifecycleProbe",
          marker,
          "update-lifecycle",
        );
      return (await api.getAllGlobalState()).updateLifecycleProbe;
    },
    { marker, initialize },
  );
  expect(
    actual,
    "Native upgrade/handover must retain the actual persisted profile",
  ).toBe(marker);
}

test("real two-version desktop update lifecycle", async () => {
  test.setTimeout(120_000);

  if (
    phase === "verify" ||
    phase === "external-after" ||
    phase === "external-adopted"
  ) {
    const { app, api, page } = await launch();
    try {
      const version = await api.currentVersion();
      expect(version).toBe(
        phase === "external-adopted" ? sourceVersion : targetVersion,
      );
      await assertProfileMarker(page);
      if (backend === "homebrew")
        expect(await api.getState()).toMatchObject({
          availability: { state: "disabled", reason: "external-macos-install" },
        });
      const flatpak =
        backend === "flatpak" && phase === "external-after"
          ? await app.evaluate(() => {
              const runtimeProcess = (
                globalThis as typeof globalThis & { process: NodeJS.Process }
              ).process;
              const fs = runtimeProcess.getBuiltinModule("node:fs");
              return {
                flatpakId: runtimeProcess.env.FLATPAK_ID ?? null,
                infoExists: fs.existsSync("/.flatpak-info"),
              };
            })
          : null;
      if (flatpak) {
        expect(flatpak).toEqual({
          flatpakId: expectedFlatpakId,
          infoExists: true,
        });
      }
      await writeEvidence({
        backend,
        channel,
        flatpak,
        phase,
        version,
        profileRetained: true,
      });
    } finally {
      await app.close();
    }
    return;
  }

  if (phase === "external-before") {
    const { app, api, page } = await launch();
    try {
      expect(await api.currentVersion()).toBe(sourceVersion);
      await assertProfileMarker(page, true);
      const reason =
        backend === "homebrew"
          ? "external-macos-install"
          : "externally-managed";
      expect(await api.getState()).toMatchObject({
        availability: { state: "disabled", reason },
        progress: null,
      });
      expect(await api.checkForUpdates()).toEqual({
        state: "unavailable",
        reason,
      });
      const flatpak =
        backend === "flatpak"
          ? await app.evaluate(() => {
              const runtimeProcess = (
                globalThis as typeof globalThis & { process: NodeJS.Process }
              ).process;
              const fs = runtimeProcess.getBuiltinModule("node:fs");
              return {
                flatpakId: runtimeProcess.env.FLATPAK_ID ?? null,
                infoExists: fs.existsSync("/.flatpak-info"),
              };
            })
          : null;
      if (flatpak)
        expect(flatpak).toEqual({
          flatpakId: expectedFlatpakId,
          infoExists: true,
        });
      await writeEvidence({
        backend,
        channel,
        flatpak,
        phase,
        updaterState: reason,
        version: sourceVersion,
      });
    } finally {
      await app.close();
    }
    return;
  }

  if (!artifactPath || !Number.isInteger(feedPort) || feedPort < 1024) {
    throw new Error(
      "Update phase requires a real artifact and a non-privileged feed port",
    );
  }
  const fixture = await startRealUpdateFeedServer({
    artifactPath,
    channel,
    port: feedPort,
    version: targetVersion,
  });
  const { app, api, page } = await launch(fixture.certificateSpkiSha256);
  try {
    expect(await api.currentVersion()).toBe(sourceVersion);
    await assertProfileMarker(page, true);

    if (backend === "zip") {
      expect(await api.getState()).toMatchObject({
        availability: { state: "disabled", reason: "portable" },
        progress: null,
      });
      expect(await api.checkForUpdates()).toEqual({
        state: "unavailable",
        reason: "portable",
      });
      const server = fixture.evidence();
      expect(server.releaseRequests).toBe(0);
      expect(server.manifestRequests).toBe(0);
      expect(server.artifactRequests).toBe(0);
      await writeEvidence({
        backend,
        channel,
        phase,
        server,
        updaterState: "portable",
        version: sourceVersion,
      });
      return;
    }

    expect(await api.getState()).toMatchObject({
      availability: { state: "enabled" },
      progress: null,
    });
    const lifecycle = await api.downloadLifecycle(targetVersion);
    expect(lifecycle.checked).toEqual({
      state: "checked",
      version: targetVersion,
    });
    expect(lifecycle.available.at(-1)).toEqual({
      allowAutoUpdate: true,
      version: targetVersion,
    });
    expect(lifecycle.progress.at(0)).toBe(0);
    const progressMode = "percent";
    expect(lifecycle.progress.some((value) => value > 0)).toBe(true);
    expect(lifecycle.progress.at(-1)).toBeCloseTo(100, 3);
    expect(lifecycle.ready.at(-1)).toEqual({
      allowAutoUpdate: true,
      version: targetVersion,
    });
    const server = fixture.evidence();
    expect(server.releaseRequests).toBeGreaterThanOrEqual(1);
    expect(server.manifestRequests).toBeGreaterThanOrEqual(1);
    expect(server.artifactRequests).toBeGreaterThanOrEqual(1);
    expect(server.bytesServed).toBeGreaterThanOrEqual(fixture.artifactSize);
    const artifactHash = createHash("sha512");
    for await (const chunk of createReadStream(artifactPath))
      artifactHash.update(chunk);
    expect(artifactHash.digest("base64")).toBe(fixture.artifactSha512);

    await writeEvidence({
      artifact: {
        name: fixture.artifactName,
        sha512: fixture.artifactSha512,
        size: fixture.artifactSize,
      },
      backend,
      channel,
      lifecycle,
      phase,
      progressMode,
      server,
      sourceVersion,
      targetVersion,
    });
    const exited = new Promise<void>((resolve, reject) => {
      if (
        app.process().exitCode !== null ||
        app.process().signalCode !== null
      ) {
        resolve();
        return;
      }
      const timeout = setTimeout(
        () => reject(new Error("Electron did not exit for update activation")),
        30_000,
      );
      app.process().once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    await Promise.all([
      api.quitAndInstall().catch(async (error) => {
        // Successful activation can close the renderer before the triggering
        // IPC reply arrives. Accept only that specific error after a real exit;
        // the wrapper still verifies installed bytes, version and profile.
        if (
          !(error instanceof Error) ||
          !error.message.includes(
            "Target page, context or browser has been closed",
          )
        )
          throw error;
        await exited;
      }),
      exited,
    ]);
  } finally {
    // Release Playwright's inspector/context even when the updater already
    // exited Main; process exit alone does not dispose the automation owner.
    await app.close();
    await fixture.close();
  }
});
