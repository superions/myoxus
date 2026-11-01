// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { UpdateInfo, UpdaterState } from "@myoxus/desktop-api-contract";
import { expect, test } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright";

import { startRealUpdateFeedServer } from "../fixtures/update-feed-server";

type Backend = "deb" | "flatpak" | "macos" | "nsis" | "rpm" | "zip";
type Phase = "external-after" | "external-before" | "update" | "verify";

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
  !["deb", "flatpak", "macos", "nsis", "rpm", "zip"].includes(backend) ||
  !["external-after", "external-before", "update", "verify"].includes(phase) ||
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
): Promise<{ app: ElectronApplication; api: UpdateApi }> {
  const environment = { ...process.env };
  delete environment.ELECTRON_E2E;
  delete environment.ELECTRON_E2E_PACKAGE_TYPE;
  delete environment.ELECTRON_E2E_UPDATE_FEED;
  const app = await electron.launch({
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

test("real two-version desktop update lifecycle", async () => {
  test.setTimeout(120_000);

  if (phase === "verify" || phase === "external-after") {
    const { app, api } = await launch();
    try {
      const version = await api.currentVersion();
      expect(version).toBe(targetVersion);
      const flatpak =
        phase === "external-after"
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
      await writeEvidence({ backend, channel, flatpak, phase, version });
    } finally {
      await app.close();
    }
    return;
  }

  if (phase === "external-before") {
    const { app, api } = await launch();
    try {
      expect(await api.currentVersion()).toBe(sourceVersion);
      expect(await api.getState()).toMatchObject({
        availability: { state: "disabled", reason: "externally-managed" },
        progress: null,
      });
      expect(await api.checkForUpdates()).toEqual({
        state: "unavailable",
        reason: "externally-managed",
      });
      const flatpak = await app.evaluate(() => {
        const runtimeProcess = (
          globalThis as typeof globalThis & { process: NodeJS.Process }
        ).process;
        const fs = runtimeProcess.getBuiltinModule("node:fs");
        return {
          flatpakId: runtimeProcess.env.FLATPAK_ID ?? null,
          infoExists: fs.existsSync("/.flatpak-info"),
        };
      });
      expect(flatpak).toEqual({
        flatpakId: expectedFlatpakId,
        infoExists: true,
      });
      await writeEvidence({
        backend,
        channel,
        flatpak,
        phase,
        updaterState: "externally-managed",
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
  const { app, api } = await launch(fixture.certificateSpkiSha256);
  try {
    expect(await api.currentVersion()).toBe(sourceVersion);

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
    const progressMode =
      backend === "macos" ? "indeterminate-native-mac" : "percent";
    if (progressMode === "percent") {
      expect(lifecycle.progress.some((value) => value > 0)).toBe(true);
      expect(lifecycle.progress.at(-1)).toBeCloseTo(100, 3);
    } else {
      expect(lifecycle.progress.every(Number.isFinite)).toBe(true);
    }
    expect(lifecycle.ready.at(-1)).toEqual({
      allowAutoUpdate: true,
      version: targetVersion,
    });
    const server = fixture.evidence();
    expect(server.releaseRequests).toBeGreaterThanOrEqual(1);
    expect(server.manifestRequests).toBeGreaterThanOrEqual(1);
    expect(server.artifactRequests).toBeGreaterThanOrEqual(1);
    expect(server.bytesServed).toBeGreaterThanOrEqual(fixture.artifactSize);
    expect(
      createHash("sha512")
        .update(await readFile(artifactPath))
        .digest("base64"),
    ).toBe(fixture.artifactSha512);

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
    await api.quitAndInstall();
    await exited;
  } finally {
    if (app.process().exitCode === null && app.process().signalCode === null) {
      await app.close();
    }
    await fixture.close();
  }
});
