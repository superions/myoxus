// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { extractFile } from "@electron/asar";
import type { ClientHandler } from "@myoxus/desktop-api-contract";
import { expect, test, type TestInfo } from "@playwright/test";
import { chromium } from "playwright";
import * as Y from "yjs";

import {
  assertPackagedElectronClassification,
  classifyRuntimeEvents,
  closeElectron,
  launchPackagedElectron,
  type MainProcessAttestation,
  type PackagedRenderer,
  removeDirectory,
  type RendererAttestation,
  type RuntimeEvent,
} from "../fixtures/packaged-runtime";
import {
  classifyOnlineRuntimeEvents,
  connectAndPasswordLogin,
  fileSha256,
  openAuthenticatedWebSession,
  requireProductFlowEnvironment,
  requireProductFlowReleaseIdentity,
  requireProductFlowServerInfo,
  seededWorkspace,
} from "../fixtures/product-flow";
import { smokeGql } from "../../../webfrontend/shared/workspace-helper";

/** Use real pointer hit testing: a menu item behind its dialog has a rectangle
 * but is not an operable product control. */
async function clickRecordingControl(
  page: PackagedRenderer,
  selector: string,
  text?: string,
) {
  let point: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        point = await page.evaluate(
          ({ selector, text }) => {
            const element = [
              ...document.querySelectorAll<HTMLElement>(selector),
            ].find((element) => {
              const bounds = element.getBoundingClientRect();
              return (
                bounds.width > 0 &&
                bounds.height > 0 &&
                (!text || element.textContent?.trim() === text)
              );
            });
            if (
              !element ||
              (element instanceof HTMLButtonElement && element.disabled)
            )
              return null;
            element.scrollIntoView({ block: "nearest" });
            const bounds = element.getBoundingClientRect();
            const x = bounds.x + bounds.width / 2;
            const y = bounds.y + bounds.height / 2;
            const hit = document.elementFromPoint(x, y);
            return bounds.width &&
              bounds.height &&
              hit &&
              (element.contains(hit) ||
                (element instanceof HTMLInputElement &&
                  [...(element.labels ?? [])].some((label) =>
                    label.contains(hit),
                  )))
              ? { x, y }
              : null;
          },
          { selector, text },
        );
        return point !== null;
      },
      {
        message: `Recording control must be visible and clickable: ${text ?? selector}`,
      },
    )
    .toBe(true);
  await page.clickAt(point!.x, point!.y);
}

async function reloadRecordingWorkbench(
  page: PackagedRenderer,
  workspaceId: string,
  docId: string,
) {
  const target = await page.evaluate(async () => {
    const tabs = await (
      window as unknown as Window & { __apis: ClientHandler }
    ).__apis.ui.getTabViewsMeta();
    const workbench = tabs.workbenches.find(
      (candidate) => candidate.id === tabs.activeWorkbenchId,
    );
    const path = workbench?.views[workbench.activeViewIndex]?.path;
    if (!workbench || !path?.pathname)
      throw new Error("The active workbench has no persisted recording route");
    const url = new URL(workbench.basename + path.pathname, location.href);
    url.search = path.search ?? "";
    url.hash = path.hash ?? "";
    return {
      url: url.href,
      pathname: url.pathname,
      timeOrigin: performance.timeOrigin,
    };
  });
  expect(target.pathname).toBe(`/workspace/${workspaceId}/${docId}`);
  // Main's Reload action loads this persisted tab route. A synthetic key event
  // alone does not prove that the native menu accelerator actually reloaded it.
  await page.navigate(target.url);
  await expect
    .poll(() => page.evaluate(() => performance.timeOrigin))
    .not.toBe(target.timeOrigin);
}

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const EVIDENCE_ROOT = path.resolve(
  process.env.MYOXUS_ELECTRON_RELEASE_EVIDENCE ??
    path.join(
      REPO_ROOT,
      "output/electron-build/P-ELECTRON-BUILD-12/local-runtime",
    ),
);

type NativeBindingEvidence = {
  cryptoResponseLength: number;
  localStore: {
    updateCount: number;
    updateSizes: number[];
  };
  mediaCapture: {
    permissions: {
      microphone: boolean;
      screen: boolean;
      systemAudio: boolean;
    };
  };
};

function profileFor(testInfo: TestInfo): string {
  return path.join(
    EVIDENCE_ROOT,
    "profiles",
    testInfo.testId.replaceAll(/[^a-zA-Z0-9_.-]/g, "-"),
  );
}

async function exerciseNativeBindings(
  page: PackagedRenderer,
  universalId: string,
  docId: string,
  update: Uint8Array,
): Promise<NativeBindingEvidence> {
  return page.evaluate(
    async ({ docId, universalId, update }) => {
      const api = (window as Window & { __apis?: ClientHandler }).__apis;
      if (!api) throw new Error("Packaged desktop IPC is unavailable");
      const challengeResponse = await api.ui.getChallengeResponse(
        "myoxus-release-smoke",
      );
      if (!challengeResponse) {
        throw new Error("Native crypto binding returned no challenge response");
      }
      await api.store.connect(universalId);
      await api.store.pushUpdate(universalId, docId, new Uint8Array(update));
      const updates = await api.store.getDocUpdates(universalId, docId);
      const permissions = await api.recording.checkMeetingPermissions();
      if (!permissions) {
        throw new Error("Native media binding returned no permission state");
      }
      return {
        cryptoResponseLength: challengeResponse.length,
        localStore: {
          updateCount: updates.length,
          updateSizes: updates.map((entry) => entry.bin.byteLength),
        },
        mediaCapture: {
          permissions,
        },
      };
    },
    { docId, universalId, update: Array.from(update) },
  );
}

async function persistedNativeUpdate(
  page: PackagedRenderer,
  universalId: string,
  docId: string,
): Promise<number[]> {
  return page.evaluate(
    async ({ docId, universalId }) => {
      const api = (window as Window & { __apis?: ClientHandler }).__apis;
      if (!api) throw new Error("Packaged desktop IPC is unavailable");
      await api.store.connect(universalId);
      return (await api.store.getDocUpdates(universalId, docId)).map(
        (entry) => entry.bin.byteLength,
      );
    },
    { docId, universalId },
  );
}

async function deleteNativeWorkspace(
  page: PackagedRenderer,
  universalId: string,
): Promise<void> {
  await page.evaluate(async (universalId) => {
    const api = (window as Window & { __apis?: ClientHandler }).__apis;
    if (!api) throw new Error("Packaged desktop IPC is unavailable");
    await api.workspace.delete(universalId);
  }, universalId);
}

async function assertCspAndOfflineFonts(page: PackagedRenderer): Promise<{
  csp: string;
  fontBytes: number;
  fontFamilies: string[];
  remoteFailure: string;
}> {
  const result = await page.evaluate(async () => {
    const remoteFailure = await fetch(
      "https://unconfigured.example.invalid/api/auth/session",
      { cache: "no-store" },
    ).then(
      (response) => `unexpected HTTP ${response.status}`,
      (error: unknown) =>
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    );
    const cspResponse = await fetch(location.href, { cache: "no-store" });
    const csp = cspResponse.headers.get("content-security-policy") ?? "";
    await document.fonts.ready;
    await document.fonts.load('16px "Inter"', "Myoxus offline font probe");
    const fontFamilies = [...document.fonts]
      .filter((font) => font.status === "loaded")
      .map((font) => font.family.replaceAll('"', ""))
      .filter((family, index, families) => families.indexOf(family) === index)
      .sort();
    const fontResponse = await fetch(
      "assets://./api/fonts/inter-regular-latin.woff2",
      { cache: "no-store" },
    );
    const fontBytes = (await fontResponse.arrayBuffer()).byteLength;
    return {
      csp,
      cspStatus: cspResponse.status,
      fontBytes,
      fontFamilies,
      fontStatus: fontResponse.status,
      remoteFailure,
    };
  });

  expect(result.remoteFailure).toMatch(
    /TypeError: Failed to fetch|net::ERR_NAME_NOT_RESOLVED/,
  );
  expect(result.cspStatus).toBe(200);
  expect(result.csp).toContain("default-src 'self'");
  expect(result.csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
  expect(result.csp).toContain("object-src 'none'");
  expect(result.csp).toContain("frame-src 'none'");
  expect(result.csp).toContain("frame-ancestors 'none'");
  expect(result.csp.split(/\s+/)).not.toContain("'unsafe-eval'");
  expect(result.fontStatus).toBe(200);
  expect(result.fontBytes).toBeGreaterThan(40_000);
  expect(result.fontFamilies).toContain("Inter");
  return result;
}

async function rendererRuntimeProbe(page: PackagedRenderer): Promise<{
  active: boolean;
  currentVersion: string;
  workerConnected: boolean;
}> {
  return page.evaluate(async () => {
    const desktopWindow = window as Window & {
      __apis?: {
        ui?: { isActiveTab?: () => Promise<boolean> };
        updater?: { currentVersion?: () => Promise<string> };
        worker?: {
          connectWorker?: (
            key: string,
            portId: string,
          ) => Promise<{ portId: string }>;
          disconnectWorker?: (key: string, portId: string) => Promise<void>;
        };
      };
    };
    const apis = desktopWindow.__apis;
    if (
      !apis?.ui?.isActiveTab ||
      !apis.updater?.currentVersion ||
      !apis.worker?.connectWorker ||
      !apis.worker.disconnectWorker
    ) {
      throw new Error("Required packaged desktop IPC surface is unavailable");
    }
    const key = `release-smoke-${crypto.randomUUID()}`;
    const portId = crypto.randomUUID();
    const connection = await apis.worker.connectWorker(key, portId);
    await apis.worker.disconnectWorker(key, portId);
    return {
      active: await apis.ui.isActiveTab(),
      currentVersion: await apis.updater.currentVersion(),
      workerConnected: connection.portId === portId,
    };
  });
}

async function setPersistentProbe(
  page: PackagedRenderer,
  key: string,
  value: string,
): Promise<void> {
  await page.evaluate(
    async ({ key, value }) => {
      const api = (
        window as Window & {
          __apis?: {
            sharedStorage?: {
              setGlobalState?: (
                key: string,
                value: string,
                sourceId?: string,
              ) => Promise<void>;
            };
          };
        }
      ).__apis?.sharedStorage;
      if (!api?.setGlobalState) {
        throw new Error("Packaged shared-state IPC is unavailable");
      }
      await api.setGlobalState(key, value, "release-smoke");
    },
    { key, value },
  );
}

async function readPersistentProbe(
  page: PackagedRenderer,
  key: string,
): Promise<unknown> {
  return page.evaluate(async (key) => {
    const api = (
      window as Window & {
        __apis?: {
          sharedStorage?: {
            getAllGlobalState?: () => Promise<Record<string, unknown>>;
          };
        };
      }
    ).__apis?.sharedStorage;
    if (!api?.getAllGlobalState) {
      throw new Error("Packaged shared-state IPC is unavailable");
    }
    return (await api.getAllGlobalState())[key];
  }, key);
}

async function deletePersistentProbe(
  page: PackagedRenderer,
  key: string,
): Promise<void> {
  await page.evaluate(async (key) => {
    const api = (
      window as Window & {
        __apis?: {
          sharedStorage?: {
            delGlobalState?: (key: string, sourceId?: string) => Promise<void>;
          };
        };
      }
    ).__apis?.sharedStorage;
    if (!api?.delGlobalState) {
      throw new Error("Packaged shared-state IPC is unavailable");
    }
    await api.delGlobalState(key, "release-smoke-cleanup");
  }, key);
}

async function writeEvidence(
  testInfo: TestInfo,
  evidence: Record<string, unknown>,
): Promise<void> {
  const file = path.join(EVIDENCE_ROOT, "release-smoke.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  await testInfo.attach("release-smoke-runtime", {
    body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`),
    contentType: "application/json",
  });
}

test.describe("P-ELECTRON-BUILD-12 packaged release runtime", () => {
  test.describe.configure({ mode: "serial" });

  test("DESK-MTG-04: real Settings capture, both destinations, playback, German transcript and service retry", async ({
    request,
  }, testInfo) => {
    test.setTimeout(300_000);
    const environment = requireProductFlowEnvironment();
    const release = requireProductFlowReleaseIdentity();
    const serverInfo = await requireProductFlowServerInfo(request, environment);
    const audioFile = process.env.E2E_RECORDING_AUDIO_FILE;
    if (!audioFile)
      throw new Error(
        "E2E_RECORDING_AUDIO_FILE must identify the known German WAV fixture played through the real desktop audio backend",
      );
    if ((await stat(audioFile)).size > 5 * 1024 * 1024)
      throw new Error(
        "The known German recording fixture exceeds its 5 MiB bound",
      );
    const audio = await readFile(audioFile);
    if (
      audio.length > 5 * 1024 * 1024 ||
      audio.subarray(0, 4).toString() !== "RIFF"
    )
      throw new Error(
        "The known German recording fixture must be a bounded WAV file",
      );
    const web = await openAuthenticatedWebSession(request, environment);
    let workspace: Awaited<ReturnType<typeof seededWorkspace>> | undefined;
    let endpoint: string | undefined;
    const gql = <T>(query: string, variables: Record<string, unknown> = {}) =>
      smokeGql<T>(
        request,
        `${environment.apiUrl}/graphql`,
        web.cookies,
        query,
        variables,
      );
    const setEndpoint = async (value: string) => {
      const result = await gql<{
        admin: {
          adminUpdateConfig: { applied: boolean; fieldErrors: unknown[] };
        };
      }>(
        "mutation($updates:[UpdateAppConfigInput!]!){admin{adminUpdateConfig(updates:$updates){applied fieldErrors{path message}}}}",
        { updates: [{ module: "transcription", key: "endpoint", value }] },
      );
      expect(result.admin.adminUpdateConfig).toMatchObject({
        applied: true,
        fieldErrors: [],
      });
    };
    const profile = profileFor(testInfo);
    const recordingEvidenceDirectory = path.join(
      EVIDENCE_ROOT,
      "recording",
      release.sourceCommit,
    );
    const attachRecordingEvidence = async (name: string, value: unknown) => {
      await mkdir(recordingEvidenceDirectory, { recursive: true });
      const file = path.join(recordingEvidenceDirectory, `${name}.json`);
      await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
      await testInfo.attach(name, {
        path: file,
        contentType: "application/json",
      });
    };
    const deliveries: {
      id: number;
      docId: string;
      attachmentId: string;
      blobId: string;
      mode: string;
    }[] = [];
    let runtime: Awaited<ReturnType<typeof launchPackagedElectron>> | undefined;
    let ownedWorkspaceId: string | undefined;
    const recordingIds = new Set<number>();
    let endpointChanged = false;
    let originalLocale: string | null | undefined;
    let localeChanged = false;
    let recordingPopup: PackagedRenderer | undefined;
    let sourceBrowser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let journeyError: unknown;
    try {
      originalLocale = (
        await gql<{
          currentUser: {
            preferences: {
              values: { locale: string | null };
            };
          };
        }>("query{currentUser{preferences{values{locale}}}}")
      ).currentUser.preferences.values.locale;
      workspace = await seededWorkspace(request, environment, web.cookies);
      const config = await gql<{
        serverConfig: {
          features: string[];
          transcription: { enabled: boolean; configured: boolean };
        };
        admin: {
          adminConfigValues: {
            modules: {
              module: string;
              groups: { fields: { path: string; value: unknown }[] }[];
            }[];
          };
        };
      }>(
        "query { serverConfig { features transcription { enabled configured } } admin { adminConfigValues { modules { module groups { fields { path value } } } } } }",
      );
      expect(
        config.serverConfig.features.some(
          (feature) => feature.toLowerCase() === "copilot",
        ),
      ).toBe(false);
      expect(config.serverConfig.transcription).toMatchObject({
        enabled: true,
        configured: true,
      });
      const configuredEndpoint = config.admin.adminConfigValues.modules
        .flatMap((module) => module.groups.flatMap((group) => group.fields))
        .find((field) => field.path === "transcription.endpoint")?.value;
      if (typeof configuredEndpoint !== "string" || !configuredEndpoint)
        throw new Error(
          "The dedicated recording runtime requires a configured external speech service",
        );
      endpoint = configuredEndpoint;
      const organization = await gql<{
        admin: {
          organizationUnits: { id: string; parentUnitId: string | null }[];
        };
      }>("query{admin{organizationUnits{id parentUnitId}}}");
      const ownerUnit = organization.admin.organizationUnits.find(
        (unit) => unit.parentUnitId === null,
      );
      if (!ownerUnit)
        throw new Error("The seeded organization root is unavailable");
      const created = await gql<{
        createWorkspaceInOrganizationUnit: {
          id: string;
          initialized: boolean;
          name: string | null;
        };
      }>(
        "mutation($i:CreateWorkspaceInOrganizationUnitInput!){createWorkspaceInOrganizationUnit(input:$i){id initialized name}}",
        {
          i: {
            unitId: ownerUnit.id,
            name: `Native recording German playback, transcript and recovery ${randomUUID()}`,
          },
        },
      );
      ownedWorkspaceId = created.createWorkspaceInOrganizationUnit.id;
      workspace = created.createWorkspaceInOrganizationUnit;
      expect(workspace.initialized).toBe(true);

      sourceBrowser = await chromium.launch({
        // Real OS audio feeds native capture; never inject samples into IPC or
        // ask for a graphical login/permission grant to make the fixture pass.
        headless: true,
        ignoreDefaultArgs: ["--mute-audio"],
      });
      const sourcePage = await sourceBrowser.newPage();
      runtime = await launchPackagedElectron(profile);
      const provenance = extractFile(
        runtime.main.appAsarPath,
        "BUILD-PROVENANCE.txt",
      ).toString("utf8");
      expect(provenance.split("\n")).toContain(
        `source=${release.sourceCommit}`,
      );
      await attachRecordingEvidence("recording-runtime-identity", {
        release: {
          ...release,
          packagePath: undefined,
          packageSha256: await fileSha256(release.packagePath),
        },
        serverInfo,
        main: runtime.main,
      });
      const capabilities = await runtime.page.evaluate(async () => {
        const api = (window as unknown as Window & { __apis: ClientHandler })
          .__apis.recording;
        return {
          available: await api.checkRecordingAvailable(),
          permissions: await api.checkMeetingPermissions(),
        };
      });
      await attachRecordingEvidence("recording-capabilities", capabilities);
      if (
        !capabilities.available ||
        !capabilities.permissions ||
        !Object.values(capabilities.permissions).every(Boolean)
      )
        throw new Error(
          "Native recording is unavailable or permission-denied on this host; no capture accepted and no interactive permission grant attempted",
        );
      await connectAndPasswordLogin(runtime.page, environment, workspace.id);
      // The inert Web page is only a real OS audio source, not a second editor.
      await sourcePage.setContent(
        `<button id="play">Play known German audio</button><audio id="source" src="data:audio/wav;base64,${audio.toString("base64")}"></audio>`,
      );
      await sourcePage
        .locator("#play")
        .evaluate((button) =>
          button.addEventListener(
            "click",
            () =>
              void (
                document.querySelector("#source") as HTMLAudioElement
              ).play(),
          ),
        );
      for (const mode of ["new-doc", "journal-today"] as const) {
        await runtime.page.press(",", [
          release.platform === "macos" ? "Meta" : "Control",
        ]);
        await clickRecordingControl(
          runtime.page,
          "button,a,[role=button]",
          "Meetings",
        );
        const checked = await runtime.page.evaluate(
          () =>
            (
              document.querySelector(
                '[data-testid="meetings-enable-switch"]',
              ) as HTMLInputElement
            )?.checked,
        );
        if (!checked)
          await clickRecordingControl(
            runtime.page,
            '[data-testid="meetings-enable-switch"]',
          );
        const modeSelector =
          '[data-myoxus-ui-role="meetings-settings-panel"] button';
        const currentMode = await runtime.page.evaluate(
          (selector) =>
            [...document.querySelectorAll(selector)]
              .find((button) =>
                ["New doc", "Today's journal"].includes(
                  button.textContent?.trim() ?? "",
                ),
              )
              ?.textContent?.trim(),
          modeSelector,
        );
        if (!currentMode)
          throw new Error(
            "The native recording saving-mode control is unavailable",
          );
        await clickRecordingControl(runtime.page, modeSelector, currentMode);
        await clickRecordingControl(
          runtime.page,
          "[role=menuitem]",
          mode === "new-doc" ? "New doc" : "Today's journal",
        );
        await clickRecordingControl(
          runtime.page,
          '[data-testid="meetings-start-recording"]',
        );
        const status = await runtime.page.evaluate(async () =>
          (
            window as unknown as Window & { __apis: ClientHandler }
          ).__apis.recording.getCurrentRecording(),
        );
        expect(status).toMatchObject({
          status: "recording",
          destination: { workspaceId: workspace.id, savingMode: mode },
        });
        if (!status) throw new Error("Settings did not start native capture");
        recordingIds.add(status.id);
        const popup = await runtime.findRenderer(
          (identity) => identity.windowName === "recording",
          "real Settings recording popup",
        );
        recordingPopup = popup;
        await sourcePage.locator("#play").click();
        await expect
          .poll(
            () =>
              sourcePage
                .locator("#source")
                .evaluate((audio) => (audio as HTMLAudioElement).ended),
            { timeout: 30_000 },
          )
          .toBe(true);
        const stop = await popup.evaluate(() => {
          const button = [...document.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Stop",
          );
          return {
            enabled: !!button && !button.disabled,
            drag: button
              ? getComputedStyle(button).getPropertyValue("-webkit-app-region")
              : null,
            timer: document.querySelector('[role="timer"]')?.textContent,
          };
        });
        expect(stop.enabled).toBe(true);
        expect(stop.drag).toBe("no-drag");
        expect(stop.timer).toMatch(/^\d+:\d{2}$/);
        const [minutes, seconds] = stop.timer!.split(":").map(Number);
        const elapsed = Math.floor((Date.now() - status.startTime) / 1000);
        expect(elapsed).toBeGreaterThanOrEqual(5);
        expect(Math.abs(minutes * 60 + seconds - elapsed)).toBeLessThanOrEqual(
          2,
        );
        if (mode === "journal-today") {
          endpointChanged = true;
          await setEndpoint("http://127.0.0.1:1/v1");
        }
        await clickRecordingControl(popup, "button", "Stop");
        await expect
          .poll(
            async () =>
              (
                await runtime!.page.evaluate(async () =>
                  (
                    window as unknown as Window & { __apis: ClientHandler }
                  ).__apis.recording.getCurrentRecording(),
                )
              )?.status,
            { timeout: 90_000 },
          )
          .toBe("create-block-success");
        const saved = await runtime.page.evaluate(async () =>
          (
            window as unknown as Window & { __apis: ClientHandler }
          ).__apis.recording.getCurrentRecording(),
        );
        expect(saved?.destination).toEqual(status.destination);
        if (!saved?.delivery?.blobId)
          throw new Error("Saved recording has no durable attachment identity");
        deliveries.push({
          id: saved.id,
          ...saved.delivery,
          blobId: saved.delivery.blobId,
          mode,
        });
        await clickRecordingControl(popup, "button", "Open recording");
        const playerSelector = `[data-block-id="${saved.delivery.attachmentId}"] [data-myoxus-ui-role="audio-player"]`;
        await expect
          .poll(() =>
            runtime!.page.evaluate(
              (selector) => document.querySelectorAll(selector).length,
              playerSelector,
            ),
          )
          .toBe(1);
        await clickRecordingControl(
          runtime.page,
          `${playerSelector} [data-myoxus-ui-role="audio-play-toggle"]`,
        );
        await expect
          .poll(() =>
            runtime!.page.evaluate(
              (selector) =>
                document
                  .querySelector(
                    `${selector} [data-myoxus-ui-role="audio-play-toggle"]`,
                  )
                  ?.getAttribute("aria-label"),
              playerSelector,
            ),
          )
          .toBe("Pause");
        await clickRecordingControl(
          runtime.page,
          `${playerSelector} [data-myoxus-ui-role="audio-play-toggle"]`,
        );
        if (mode === "journal-today") {
          await expect
            .poll(
              () =>
                runtime!.page.evaluate(
                  (selector) =>
                    !!document.querySelector(`${selector} [role=alert]`),
                  playerSelector,
                ),
              // The standard queue retries transient service failures five
              // times, with its existing 30-second recovery sweep between attempts.
              { timeout: 180_000 },
            )
            .toBe(true);
          await setEndpoint(endpoint);
          endpointChanged = false;
          await clickRecordingControl(
            runtime.page,
            `${playerSelector} button`,
            "Retry",
          );
        }
        await expect
          .poll(
            () =>
              runtime!.page.evaluate(
                (selector) =>
                  document
                    .querySelector(selector)
                    ?.textContent?.includes("Transcription complete"),
                playerSelector,
              ),
            { timeout: 120_000 },
          )
          .toBe(true);
        await clickRecordingControl(
          runtime.page,
          `${playerSelector} button`,
          "Show transcript",
        );
        await expect
          .poll(() =>
            runtime!.page.evaluate(
              () =>
                document.body.innerText.includes("Montag") &&
                document.body.innerText.includes("Freitag"),
            ),
          )
          .toBe(true);
        await reloadRecordingWorkbench(
          runtime.page,
          workspace.id,
          saved.delivery.docId,
        );
        await expect
          .poll(() =>
            runtime!.page.evaluate(
              (selector) =>
                document
                  .querySelector(selector)
                  ?.textContent?.includes("Transcription complete"),
              playerSelector,
            ),
          )
          .toBe(true);
        const jobs = await gql<{
          currentUser: {
            copilot: { audioTranscription: { id: string; status: string }[] };
          };
        }>(
          "query($w:String!,$b:String!){currentUser{copilot(workspaceId:$w){audioTranscription(blobId:$b){id status}}}}",
          { w: workspace.id, b: saved.delivery.blobId },
        );
        expect(jobs.currentUser.copilot.audioTranscription).toHaveLength(1);
        expect(jobs.currentUser.copilot.audioTranscription[0].status).toBe(
          "Finished",
        );
      }
      await attachRecordingEvidence("recording-deliveries", deliveries);
      if (!recordingPopup)
        throw new Error("The recording popup is unavailable");
      const delivered = deliveries.at(-1)!;
      const localeStates: unknown[] = [];
      // Locale is a persisted server-owned input. Exercise consuming actions and
      // saved state without a screenshot, geometry or theme acceptance matrix.
      for (const locale of ["en", "de"] as const) {
        localeChanged = true;
        await gql(
          "mutation($i:UpdateUserPreferencesInput!){updatePreferences(input:$i){values{locale}}}",
          { i: { locale } },
        );
        await reloadRecordingWorkbench(
          runtime.page,
          workspace.id,
          delivered.docId,
        );
        const complete =
          locale === "de"
            ? "Transkription abgeschlossen"
            : "Transcription complete";
        const player = `[data-block-id="${delivered.attachmentId}"] [data-myoxus-ui-role="audio-player"]`;
        await expect
          .poll(() =>
            runtime!.page.evaluate(
              ({ player, complete }) =>
                document.querySelector(player)?.textContent?.includes(complete),
              { player, complete },
            ),
          )
          .toBe(true);
        await clickRecordingControl(
          runtime.page,
          `${player} button`,
          locale === "de" ? "Transkript anzeigen" : "Show transcript",
        );
        await runtime.page.press(",", [
          release.platform === "macos" ? "Meta" : "Control",
        ]);
        await clickRecordingControl(
          runtime.page,
          '[data-testid="meetings-panel-trigger"]',
        );
        // Saved popups normally hide after ten seconds. Reopen the same saved
        // recovery through its existing handler; this does not start a capture.
        await runtime.page.evaluate(
          async (id) =>
            (
              window as unknown as Window & { __apis: ClientHandler }
            ).__apis.recording.retryRecording(id),
          delivered.id,
        );
        await recordingPopup.reload();
        await expect
          .poll(() =>
            recordingPopup!.evaluate(
              (saved) => document.body?.innerText.includes(saved) ?? false,
              locale === "de" ? "Gespeichert" : "Saved",
            ),
          )
          .toBe(true);
        const popupState = await recordingPopup.evaluate(() => ({
          text: document.body.innerText,
        }));
        expect(popupState.text).toContain(
          locale === "de" ? "Gespeichert" : "Saved",
        );
        localeStates.push({
          locale,
          transcriptComplete: complete,
          saved: locale === "de" ? "Gespeichert" : "Saved",
        });
        await runtime.page.press("Escape");
      }
      await attachRecordingEvidence("recording-locale-states", localeStates);
      const recordingServerId = (
        await runtime.page.evaluate(async () =>
          (
            window as unknown as Window & { __apis: ClientHandler }
          ).__apis.recording.getCurrentRecording(),
        )
      )?.destination?.serverId;
      if (!recordingServerId)
        throw new Error(
          "The native journey lost its registered recording server",
        );
      const online = classifyOnlineRuntimeEvents(
        runtime.events,
        recordingServerId,
      );
      const themePath = `/_server/${encodeURIComponent(recordingServerId)}/api/branding/theme.css`;
      const obsoleteThemeReads = online.unexpected.filter((event) => {
        if (event.source !== "requestfailed") return false;
        const url = new URL(event.url);
        return (
          event.method === "GET" &&
          event.text === "net::ERR_ABORTED" &&
          url.protocol === "assets:" &&
          url.pathname === themePath &&
          url.searchParams.get("workspaceId") === workspace!.id
        );
      });
      expect(
        online.unexpected.filter(
          (event) => !obsoleteThemeReads.includes(event),
        ),
      ).toEqual([]);
    } catch (error) {
      journeyError = error;
      throw journeyError;
    } finally {
      // Cleanup failures remain findings while every independent resource is closed.
      const cleanupErrors: unknown[] = [];
      const cleanup = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (endpointChanged && endpoint)
        await cleanup(() => setEndpoint(endpoint!));
      if (runtime && workspace) {
        await cleanup(async () => {
          const current = await runtime!.page.evaluate(async () =>
            (
              window as unknown as Window & { __apis: ClientHandler }
            ).__apis.recording.getCurrentRecording(),
          );
          if (
            current &&
            recordingIds.has(current.id) &&
            ["recording", "paused"].includes(current.status)
          )
            await runtime!.page.evaluate(
              async (id) =>
                (
                  window as unknown as Window & { __apis: ClientHandler }
                ).__apis.recording.stopRecording(id),
              current.id,
            );
        });
      }
      if (runtime) await cleanup(() => closeElectron(runtime!));
      if (localeChanged && originalLocale !== undefined)
        await cleanup(async () => {
          const restored = await gql<{
            updatePreferences: { values: { locale: typeof originalLocale } };
          }>(
            "mutation($i:UpdateUserPreferencesInput!){updatePreferences(input:$i){values{locale}}}",
            { i: { locale: originalLocale } },
          );
          expect(restored.updatePreferences.values.locale).toBe(originalLocale);
        });
      if (ownedWorkspaceId)
        await cleanup(async () => {
          // This workspace belongs solely to this journey; remove its audio
          // through the blob API before deleting the workspace metadata.
          const result = await gql<{
            workspace: { blobs: { key: string }[] };
          }>("query($w:String!){workspace(id:$w){blobs{key}}}", {
            w: ownedWorkspaceId,
          });
          for (const blob of result.workspace.blobs)
            await cleanup(async () => {
              const removed = await gql<{ deleteBlob: boolean }>(
                "mutation($w:String!,$k:String!){deleteBlob(workspaceId:$w,key:$k,permanently:true)}",
                { w: ownedWorkspaceId, k: blob.key },
              );
              expect(removed.deleteBlob).toBe(true);
            });
        });
      if (ownedWorkspaceId)
        await cleanup(async () => {
          const deleted = await gql<{ admin: { deleteWorkspace: boolean } }>(
            "mutation($id:ID!){admin{deleteWorkspace(id:$id)}}",
            { id: ownedWorkspaceId },
          );
          expect(deleted.admin.deleteWorkspace).toBe(true);
          const readback = await gql<{
            admin: { adminWorkspace: { id: string } | null };
          }>("query($w:String!){admin{adminWorkspace(id:$w){id}}}", {
            w: ownedWorkspaceId,
          });
          expect(readback.admin.adminWorkspace).toBeNull();
        });
      if (sourceBrowser) await cleanup(() => sourceBrowser!.close());
      await cleanup(() => web.signOut());
      await cleanup(() => web.browser.close());
      await cleanup(() => removeDirectory(profile));
      if (cleanupErrors.length)
        throw new AggregateError(
          cleanupErrors,
          "Recording journey cleanup failed",
          { cause: journeyError },
        );
    }
  });

  test("rejects a real browser even when renderer globals are forged", async () => {
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto("data:text/html,<title>browser-only fixture</title>");
      const renderer = await page.evaluate(() => {
        Reflect.set(window, "__appInfo", {
          electron: true,
          scheme: "myoxus",
          viewId: "app-forged",
          windowName: "main",
        });
        Reflect.set(window, "__apis", {
          sharedStorage: { getAllGlobalState: () => ({}) },
          ui: { isActiveTab: () => true },
          updater: { currentVersion: () => "0.0.0" },
          worker: { connectWorker: () => ({ portId: "forged" }) },
        });
        const desktopWindow = window as Window & {
          __apis?: Record<string, Record<string, unknown>>;
          __appInfo?: RendererAttestation["appInfo"];
          process?: unknown;
          require?: unknown;
        };
        return {
          appInfo: desktopWindow.__appInfo ?? null,
          bridgeMethods: {
            currentVersion:
              typeof desktopWindow.__apis?.updater?.currentVersion,
            getAllGlobalState:
              typeof desktopWindow.__apis?.sharedStorage?.getAllGlobalState,
            isActiveTab: typeof desktopWindow.__apis?.ui?.isActiveTab,
            workerConnect: typeof desktopWindow.__apis?.worker?.connectWorker,
          },
          hasElectronUserAgent: navigator.userAgent.includes("Electron/"),
          hasNodeGlobal: desktopWindow.process !== undefined,
          hasRequireGlobal: desktopWindow.require !== undefined,
          url: location.href,
          userAgent: navigator.userAgent,
        } satisfies RendererAttestation;
      });

      await expect(
        assertPackagedElectronClassification({ renderer }),
      ).rejects.toThrow(
        "Browser-only evidence cannot attest a packaged Electron main process",
      );
      expect(renderer.hasElectronUserAgent).toBe(false);
      expect(renderer.url).toMatch(/^data:text\/html/);
    } finally {
      await browser.close();
    }
  });

  test("attests native runtime, CSP, offline fonts and restart persistence", async () => {
    const testInfo = test.info();
    const profile = profileFor(testInfo);
    const persistenceKey = `release-smoke:${randomUUID()}`;
    const persistenceValue = `persisted:${randomUUID()}`;
    const workspaceId = randomUUID();
    const universalId = `@peer(local);@type(workspace);@id(${workspaceId});`;
    const docId = `release-smoke-${randomUUID()}`;
    const document = new Y.Doc();
    document.getText("content").insert(0, "Persisted native release smoke");
    const nativeUpdate = Y.encodeStateAsUpdate(document);
    await removeDirectory(profile);

    let first: Awaited<ReturnType<typeof launchPackagedElectron>> | undefined;
    let second: Awaited<ReturnType<typeof launchPackagedElectron>> | undefined;
    const evidence: {
      first?: {
        csp: string;
        fontBytes: number;
        fontFamilies: string[];
        remoteFailure: string;
        main: MainProcessAttestation;
        nativeBindings: NativeBindingEvidence;
        renderer: RendererAttestation;
        runtimeProbe: Awaited<ReturnType<typeof rendererRuntimeProbe>>;
        shell: RendererAttestation;
      };
      persistedAfterRestart?: boolean;
      persistedNativeUpdateSizes?: number[];
      profile: string;
      rendererEvents: RuntimeEvent[];
      second?: {
        main: MainProcessAttestation;
        renderer: RendererAttestation;
        shell: RendererAttestation;
      };
    } = {
      profile,
      rendererEvents: [],
    };

    try {
      first = await launchPackagedElectron(profile);
      await assertPackagedElectronClassification({
        main: first.main,
        renderer: first.renderer,
        shell: first.shell,
      });

      const nativeBindings = await exerciseNativeBindings(
        first.page,
        universalId,
        docId,
        nativeUpdate,
      );
      expect(nativeBindings.cryptoResponseLength).toBeGreaterThan(10);
      expect(nativeBindings.localStore.updateCount).toBeGreaterThan(0);
      expect(
        nativeBindings.localStore.updateSizes.some((size) => size > 0),
      ).toBe(true);
      for (const permission of Object.values(
        nativeBindings.mediaCapture.permissions,
      )) {
        expect(typeof permission).toBe("boolean");
      }
      expect(first.stderr.join("")).not.toMatch(
        /(?:Cannot find module|module did not self-register|invalid ELF header).*(?:myoxus_(?:crypto|media|storage)|@myoxus\/(?:crypto|local-store|media-capture))/is,
      );
      const runtimeProbe = await rendererRuntimeProbe(first.page);
      expect(runtimeProbe).toEqual({
        active: true,
        currentVersion: first.main.appVersion,
        workerConnected: true,
      });
      const fontAndCsp = await assertCspAndOfflineFonts(first.page);
      // Capture and popup operation belong to DESK-MTG-04, not installation.
      await setPersistentProbe(first.page, persistenceKey, persistenceValue);
      expect(await readPersistentProbe(first.page, persistenceKey)).toBe(
        persistenceValue,
      );
      evidence.first = {
        ...fontAndCsp,
        main: first.main,
        nativeBindings,
        renderer: first.renderer,
        runtimeProbe,
        shell: first.shell,
      };
      evidence.rendererEvents.push(...first.events);

      await closeElectron(first);
      first = undefined;

      second = await launchPackagedElectron(profile);
      await assertPackagedElectronClassification({
        main: second.main,
        renderer: second.renderer,
        shell: second.shell,
      });
      expect(second.main.appVersion).toBe(evidence.first.main.appVersion);
      expect(await readPersistentProbe(second.page, persistenceKey)).toBe(
        persistenceValue,
      );
      const persistedUpdateSizes = await persistedNativeUpdate(
        second.page,
        universalId,
        docId,
      );
      expect(persistedUpdateSizes.some((size) => size > 0)).toBe(true);
      evidence.persistedAfterRestart = true;
      evidence.persistedNativeUpdateSizes = persistedUpdateSizes;
      evidence.second = {
        main: second.main,
        renderer: second.renderer,
        shell: second.shell,
      };
      await deletePersistentProbe(second.page, persistenceKey);
      expect(await readPersistentProbe(second.page, persistenceKey)).toBe(
        undefined,
      );
      await deleteNativeWorkspace(second.page, universalId);
      evidence.rendererEvents.push(...second.events);

      const classifiedEvents = classifyRuntimeEvents(evidence.rendererEvents);
      expect(
        classifiedEvents.unexpected,
        "packaged renderers emitted unexpected console, page, or request errors",
      ).toEqual([]);
      await writeEvidence(testInfo, evidence);
    } finally {
      if (first) await closeElectron(first);
      if (second) await closeElectron(second);
      await removeDirectory(profile);
    }
  });
});
