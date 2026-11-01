// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import type { ClientHandler } from "@myoxus/desktop-api-contract";
import { expect, test } from "@playwright/test";
import { type Browser, chromium, type Page } from "playwright";
import * as Y from "yjs";

import {
  type ManagedProcess,
  startProcess,
} from "../../../../../client/apps/electron/scripts/lib/process";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const PACKAGE_KIND = requiredEnvironment("MYOXUS_LINUX_PACKAGE_KIND");
const OUTPUT_ROOT = path.resolve(
  requiredEnvironment("MYOXUS_LINUX_PACKAGE_EVIDENCE"),
);
const PROFILE = path.resolve(requiredEnvironment("MYOXUS_ELECTRON_PROFILE"));
const IMPORT_PATH = path.resolve(
  requiredEnvironment("MYOXUS_ELECTRON_IMPORT_PATH"),
);
const IMPORT_HOST_PATH = path.resolve(
  process.env.MYOXUS_ELECTRON_IMPORT_HOST_PATH ?? IMPORT_PATH,
);
const EXPORT_HOST_PATH = path.resolve(
  requiredEnvironment("MYOXUS_ELECTRON_EXPORT_HOST_PATH"),
);
const LAUNCH_COMMAND = requiredEnvironment("MYOXUS_ELECTRON_LAUNCH_COMMAND");
const LAUNCH_ARGUMENTS = parseLaunchArguments();

type RendererEvent = {
  source: "console" | "pageerror" | "requestfailed";
  text: string;
  type: string;
  url: string;
};

type ProcessTreeEntry = {
  arguments: string[];
  pid: number;
  ppid: number;
  seccomp: number | null;
};

type RunningPackage = {
  browser: Browser;
  events: RendererEvent[];
  managed: ManagedProcess;
  stderr: string[];
  stdout: string[];
};

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseLaunchArguments(): string[] {
  const raw = requiredEnvironment("MYOXUS_ELECTRON_LAUNCH_ARGUMENTS");
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some((value) => typeof value !== "string")
  ) {
    throw new Error(
      "MYOXUS_ELECTRON_LAUNCH_ARGUMENTS must be a JSON string array",
    );
  }
  if (parsed.includes("--no-sandbox")) {
    throw new Error("--no-sandbox is forbidden in package runtime evidence");
  }
  return parsed;
}

function launchEnvironment(): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  delete environment.BUILD_TYPE;
  delete environment.BUILD_TYPE_OVERRIDE;
  delete environment.DEV_SERVER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  delete environment.NODE_OPTIONS;
  return {
    ...environment,
    CI: "1",
    NODE_ENV: "production",
    SKIP_ONBOARDING: "1",
  };
}

async function launchInstalledPackage(): Promise<RunningPackage> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let resolveEndpoint: ((endpoint: string) => void) | undefined;
  let rejectEndpoint: ((error: Error) => void) | undefined;
  const endpoint = new Promise<string>((resolve, reject) => {
    resolveEndpoint = resolve;
    rejectEndpoint = reject;
  });
  const managed = startProcess({
    args: [
      ...LAUNCH_ARGUMENTS,
      "--remote-debugging-port=0",
      `--user-data-dir=${PROFILE}`,
      "--no-first-run",
    ],
    command: LAUNCH_COMMAND,
    cwd: REPO_ROOT,
    env: launchEnvironment(),
    stdio: "pipe",
  });
  const inspectChunk = (target: string[], chunk: Buffer | string) => {
    const value = String(chunk);
    target.push(value);
    const match = value.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) resolveEndpoint?.(match[1]);
  };
  managed.child.stdout?.on("data", (chunk) => inspectChunk(stdout, chunk));
  managed.child.stderr?.on("data", (chunk) => inspectChunk(stderr, chunk));
  managed.child.once("error", (error) => rejectEndpoint?.(error));
  managed.child.once("exit", (code, signal) => {
    rejectEndpoint?.(
      new Error(
        `Installed package exited before CDP attach: ${code ?? "null"}/${signal ?? "none"}`,
      ),
    );
  });

  let websocket: string;
  try {
    websocket = await Promise.race([
      endpoint,
      delay(30_000).then(() => {
        throw new Error("Installed package did not expose a CDP endpoint");
      }),
    ]);
  } catch (error) {
    await managed.stop("CDP startup failure");
    throw error;
  }
  const browser = await chromium.connectOverCDP(websocket, {
    timeout: 30_000,
  });
  const events: RendererEvent[] = [];
  for (const context of browser.contexts()) {
    context.pages().forEach((page) => attachRendererEvidence(page, events));
    context.on("page", (page) => attachRendererEvidence(page, events));
  }
  return { browser, events, managed, stderr, stdout };
}

function attachRendererEvidence(page: Page, events: RendererEvent[]): void {
  page.on("console", (message) => {
    events.push({
      source: "console",
      text: message.text(),
      type: message.type(),
      url: page.url(),
    });
  });
  page.on("pageerror", (error) => {
    events.push({
      source: "pageerror",
      text: error.stack ?? error.message,
      type: "error",
      url: page.url(),
    });
  });
  page.on("requestfailed", (request) => {
    events.push({
      source: "requestfailed",
      text: request.failure()?.errorText ?? "unknown request failure",
      type: "error",
      url: request.url(),
    });
  });
}

async function activePage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const active = await page
          .evaluate(async () => {
            const desktop = window as Window & {
              __apis?: ClientHandler;
              __appInfo?: { viewId?: string; windowName?: string };
            };
            return (
              desktop.__appInfo?.windowName === "main" &&
              desktop.__appInfo.viewId?.startsWith("app-") === true &&
              (await desktop.__apis?.ui.isActiveTab()) === true
            );
          })
          .catch(() => false);
        if (active) return page;
      }
    }
    await delay(100);
  }
  throw new Error(
    "Installed package did not expose its active renderer over CDP",
  );
}

async function stopInstalledPackage(running: RunningPackage): Promise<void> {
  await running.browser.close().catch(() => undefined);
  await running.managed.stop("package smoke complete");
  await running.managed.completion;
}

async function linuxProcessTree(rootPid: number): Promise<ProcessTreeEntry[]> {
  const entries: ProcessTreeEntry[] = [];
  for (const directory of await readdir("/proc")) {
    if (!/^\d+$/.test(directory)) continue;
    const pid = Number(directory);
    try {
      const [statContent, status, commandLine] = await Promise.all([
        readFile(`/proc/${pid}/stat`, "utf8"),
        readFile(`/proc/${pid}/status`, "utf8"),
        readFile(`/proc/${pid}/cmdline`),
      ]);
      const tail = statContent
        .slice(statContent.lastIndexOf(")") + 2)
        .split(" ");
      entries.push({
        arguments: commandLine.toString().split("\0").filter(Boolean),
        pid,
        ppid: Number(tail[1]),
        seccomp:
          Number(status.match(/^Seccomp:\s+(\d+)$/m)?.[1] ?? NaN) || null,
      });
    } catch {
      // A process can disappear while /proc is being enumerated.
    }
  }
  const descendants = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of entries) {
      if (descendants.has(entry.ppid) && !descendants.has(entry.pid)) {
        descendants.add(entry.pid);
        changed = true;
      }
    }
  }
  return entries.filter((entry) => descendants.has(entry.pid));
}

async function findDialogWindow(pattern: string): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await execFileAsync(
        "xdotool",
        ["search", "--onlyvisible", "--name", pattern],
        { timeout: 2_000 },
      );
      const ids = stdout.trim().split("\n").filter(Boolean);
      if (ids.length > 0) return ids.at(-1)!;
    } catch {
      // The native or portal dialog is not mapped yet.
    }
    await delay(100);
  }
  throw new Error(`File chooser matching ${pattern} did not appear`);
}

async function choosePathInDialog(
  pattern: string,
  selectedPath: string,
  confirmSave: boolean,
): Promise<void> {
  const windowId = await findDialogWindow(pattern);
  await execFileAsync("xdotool", ["windowactivate", "--sync", windowId]);
  await execFileAsync("xdotool", ["key", "ctrl+l"]);
  await execFileAsync("xdotool", [
    "type",
    "--clearmodifiers",
    "--delay",
    "1",
    "--",
    selectedPath,
  ]);
  await execFileAsync("xdotool", ["key", "Return"]);
  if (confirmSave) {
    await delay(500);
    await execFileAsync("xdotool", ["key", "Return"]);
  }
}

async function scanFilesForNeedle(
  root: string,
  needle: Buffer,
): Promise<string[]> {
  const matches: string[] = [];
  async function visit(candidate: string): Promise<void> {
    let metadata;
    try {
      metadata = await stat(candidate);
    } catch {
      return;
    }
    if (metadata.isDirectory()) {
      for (const child of await readdir(candidate))
        await visit(path.join(candidate, child));
    } else if (
      metadata.isFile() &&
      metadata.size <= 64 * 1024 * 1024 &&
      (await readFile(candidate)).includes(needle)
    ) {
      matches.push(candidate);
    }
  }
  await visit(root);
  return matches;
}

async function writeEvidence(name: string, value: string | Buffer | object) {
  await mkdir(OUTPUT_ROOT, { recursive: true });
  await writeFile(
    path.join(OUTPUT_ROOT, name),
    typeof value === "string" || Buffer.isBuffer(value)
      ? value
      : `${JSON.stringify(value, null, 2)}\n`,
  );
}

test("installed production package preserves sandboxed local work, portals, audio, and restart state", async () => {
  test.setTimeout(240_000);
  expect(process.getuid?.()).not.toBe(0);
  expect(LAUNCH_ARGUMENTS).not.toContain("--no-sandbox");
  await mkdir(OUTPUT_ROOT, { recursive: true });

  const document = new Y.Doc();
  document
    .getText("content")
    .insert(0, "Installed package persisted this edit");
  const update = Array.from(Y.encodeStateAsUpdate(document));
  const docId = "package-runtime-document";
  let workspaceId = "";
  let universalId = "";
  let firstRun: RunningPackage | undefined;

  try {
    firstRun = await launchInstalledPackage();
    const page = await activePage(firstRun.browser);
    const runtime = await page.evaluate(async () => {
      const desktop = window as Window & {
        __apis?: ClientHandler;
        process?: unknown;
      };
      await document.fonts.ready;
      return {
        apiNamespaces: Object.keys(desktop.__apis ?? {}).sort(),
        bodyText: document.body.innerText.trim(),
        fontCount: document.fonts.size,
        rendererProcessExposed: desktop.process !== undefined,
        userAgent: navigator.userAgent,
      };
    });
    const electronManifest = JSON.parse(
      await readFile(
        path.join(REPO_ROOT, "client/apps/electron/package.json"),
        "utf8",
      ),
    );
    expect(runtime.userAgent).toContain(
      `Electron/${electronManifest.devDependencies.electron}`,
    );
    expect(runtime.rendererProcessExposed).toBe(false);
    expect(runtime.bodyText.length).toBeGreaterThan(0);
    expect(runtime.fontCount).toBeGreaterThan(0);
    expect(runtime.apiNamespaces).toEqual(
      expect.arrayContaining(["dialog", "recording", "store", "workspace"]),
    );

    const processTree = await linuxProcessTree(
      firstRun.managed.child.pid ?? -1,
    );
    const argumentsList = processTree.flatMap((entry) => entry.arguments);
    expect(argumentsList).not.toContain("--no-sandbox");
    expect(
      processTree.some((entry) => entry.arguments.includes("--type=zygote")),
    ).toBe(true);
    const renderers = processTree.filter((entry) =>
      entry.arguments.includes("--type=renderer"),
    );
    expect(renderers.length).toBeGreaterThan(0);
    expect(renderers.every((entry) => entry.seccomp === 2)).toBe(true);

    await expect(
      page.evaluate(async () => {
        const api = (window as Window & { __apis?: ClientHandler }).__apis;
        if (!api) throw new Error("Desktop IPC is unavailable");
        await api.dialog.setFakeDialogResult({ canceled: true });
      }),
    ).rejects.toThrow("Test dialog injection is unavailable in release builds");

    const importResultPromise = page.evaluate(async () => {
      const api = (window as Window & { __apis?: ClientHandler }).__apis;
      if (!api) throw new Error("Desktop IPC is unavailable");
      return api.dialog.loadDBFile();
    });
    await choosePathInDialog("Load Workspace|Open", IMPORT_PATH, false);
    const imported = await importResultPromise;
    expect(imported.error).toBeUndefined();
    expect(imported.workspaceId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    workspaceId = imported.workspaceId!;
    universalId = `@peer(local);@type(workspace);@id(${workspaceId});`;

    await page.evaluate(
      async ({ docId, universalId, update }) => {
        const api = (window as Window & { __apis?: ClientHandler }).__apis;
        if (!api) throw new Error("Desktop IPC is unavailable");
        await api.store.connect(universalId);
        await api.store.pushUpdate(universalId, docId, new Uint8Array(update));
      },
      { docId, universalId, update },
    );

    const pdfBytes = await readFile(
      path.join(REPO_ROOT, "tests/client/shared/fixtures/lorem-ipsum.pdf"),
    );
    const pdfPath = `${EXPORT_HOST_PATH}.pdf`;
    const pdfSave = page.evaluate(async (bytes) => {
      const api = (window as Window & { __apis?: ClientHandler }).__apis;
      if (!api) throw new Error("Desktop IPC is unavailable");
      return api.ui.savePdf(
        "Überblick 東京-v1-2026-10-11.pdf",
        new Uint8Array(bytes).buffer,
      );
    }, Array.from(pdfBytes));
    await choosePathInDialog("Save File|Save", pdfPath, true);
    expect(await pdfSave).toEqual({ status: "saved" });
    expect(await readFile(pdfPath)).toEqual(pdfBytes);
    const pdfCancel = page.evaluate(async (bytes) => {
      const api = (window as Window & { __apis?: ClientHandler }).__apis;
      if (!api) throw new Error("Desktop IPC is unavailable");
      return api.ui.savePdf("cancelled.pdf", new Uint8Array(bytes).buffer);
    }, Array.from(pdfBytes));
    const cancelWindow = await findDialogWindow("Save File|Save");
    await execFileAsync("xdotool", ["windowactivate", "--sync", cancelWindow]);
    await execFileAsync("xdotool", ["key", "Escape"]);
    expect(await pdfCancel).toEqual({ status: "cancelled" });
    expect(await readFile(pdfPath)).toEqual(pdfBytes);

    const exportResultPromise = page.evaluate(
      async ({ universalId }) => {
        const api = (window as Window & { __apis?: ClientHandler }).__apis;
        if (!api) throw new Error("Desktop IPC is unavailable");
        return api.dialog.saveDBFileAs(universalId, "Package runtime");
      },
      { universalId },
    );
    await choosePathInDialog("Save Workspace|Save", EXPORT_HOST_PATH, true);
    const exported = await exportResultPromise;
    expect(exported.error).toBeUndefined();
    expect(exported.canceled).not.toBe(true);
    expect((await stat(EXPORT_HOST_PATH)).size).toBeGreaterThan(0);

    const audio = await page.evaluate(async () => {
      const api = (window as Window & { __apis?: ClientHandler }).__apis;
      if (!api) throw new Error("Desktop IPC is unavailable");
      const setup = await api.recording.setupRecordingFeature();
      const permissions = await api.recording.checkMeetingPermissions();
      const started = await api.recording.startRecording();
      if (!started || started.status !== "recording") {
        throw new Error(
          `System recording did not start: ${JSON.stringify(started)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const stopped = await api.recording.stopRecording(started.id);
      const raw = await api.recording.getRawAudioBuffers(started.id, 0);
      await api.recording.removeRecording(started.id);
      return {
        byteLength: raw.buffer.byteLength,
        permissions,
        setup,
        status: stopped?.status,
      };
    });
    expect(audio.permissions?.systemAudio).toBe(true);
    expect(audio.byteLength).toBeGreaterThan(0);
    expect(audio.status).toBe("stopped");

    await page.screenshot({
      fullPage: true,
      path: path.join(OUTPUT_ROOT, `${PACKAGE_KIND}-installed.png`),
    });
    const fatalEvents = firstRun.events.filter(
      (event) =>
        event.source === "pageerror" ||
        (event.source === "console" && event.type === "error"),
    );
    expect(fatalEvents).toEqual([]);
    await writeEvidence(`${PACKAGE_KIND}-first-run.json`, {
      audio,
      importedWorkspaceId: workspaceId,
      processTree,
      runtime,
    });
  } finally {
    if (firstRun) {
      await stopInstalledPackage(firstRun);
      await Promise.all([
        writeEvidence(
          `${PACKAGE_KIND}-main.stdout.log`,
          firstRun.stdout.join(""),
        ),
        writeEvidence(
          `${PACKAGE_KIND}-main.stderr.log`,
          firstRun.stderr.join(""),
        ),
        writeEvidence(`${PACKAGE_KIND}-renderer-events.json`, firstRun.events),
      ]);
    }
  }

  const secondRun = await launchInstalledPackage();
  try {
    const page = await activePage(secondRun.browser);
    const persisted = await page.evaluate(
      async ({ docId, universalId, workspaceId }) => {
        const api = (window as Window & { __apis?: ClientHandler }).__apis;
        if (!api) throw new Error("Desktop IPC is unavailable");
        const workspaceIds = await api.workspace.listLocalWorkspaceIds();
        await api.store.connect(universalId);
        const updates = await api.store.getDocUpdates(universalId, docId);
        return {
          updateSizes: updates.map((entry) => entry.bin.byteLength),
          workspaceIds,
          workspaceId,
        };
      },
      { docId, universalId, workspaceId },
    );
    expect(persisted.workspaceIds).toContain(workspaceId);
    expect(persisted.updateSizes.some((size) => size > 0)).toBe(true);
    expect(
      await scanFilesForNeedle(PROFILE, Buffer.from(IMPORT_HOST_PATH)),
    ).toEqual([]);
    await writeEvidence(`${PACKAGE_KIND}-restart.json`, persisted);
  } finally {
    await stopInstalledPackage(secondRun);
  }

  const exportedHash = createHash("sha256")
    .update(await readFile(EXPORT_HOST_PATH))
    .digest("hex");
  await writeEvidence(`${PACKAGE_KIND}-export.sha256`, `${exportedHash}\n`);
});
