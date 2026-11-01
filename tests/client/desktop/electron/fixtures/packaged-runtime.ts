// SPDX-License-Identifier: AGPL-3.0-or-later

import { constants } from "node:fs";
import {
  access,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { extractFile } from "@electron/asar";
import { expect } from "@playwright/test";

import {
  type ManagedProcess,
  startProcess,
} from "../../../../../client/apps/electron/scripts/lib/process";

const WINDOW_TIMEOUT = 30_000;
const SANDBOX_PRELOAD_ATTACH_GRACE = 1_000;

export type MainProcessAttestation = {
  appAsarPath: string;
  appMain: string;
  appName: string;
  appVersion: string;
  configuredExecutable: string;
  executableRealPath: string;
  nativeFiles: string[];
  packageResourcesPath: string;
  pid: number;
  processExecutablePath: string;
  wrapperPid: number;
};

export type RendererAttestation = {
  appInfo: {
    electron?: unknown;
    scheme?: unknown;
    viewId?: unknown;
    windowName?: unknown;
  } | null;
  bridgeMethods: {
    currentVersion: string;
    getAllGlobalState: string;
    isActiveTab: string;
    workerConnect: string;
  };
  hasElectronUserAgent: boolean;
  hasNodeGlobal: boolean;
  hasRequireGlobal: boolean;
  url: string;
  userAgent: string;
};

export type RuntimeEvent = {
  method?: string;
  operationType?: string;
  level: string;
  source: "console" | "pageerror" | "requestfailed";
  text: string;
  url: string;
};

export type PackagedElectronRuntime = {
  closeRenderers: () => void;
  events: RuntimeEvent[];
  executablePath: string;
  findRenderer: (
    predicate: (identity: RendererIdentity) => boolean,
    label: string,
    timeout?: number,
  ) => Promise<PackagedRenderer>;
  main: MainProcessAttestation;
  managed: ManagedProcess;
  page: PackagedRenderer;
  renderer: RendererAttestation;
  shell: RendererAttestation;
  stderr: string[];
  stdout: string[];
};

export type PackagedWindowState = {
  bounds: {
    height: number;
    left: number;
    top: number;
    width: number;
    windowState: string;
  };
  isMaximized: boolean;
  maximizationMode: "native" | "work-area-fallback";
};

export type RendererIdentity = {
  active: boolean;
  viewId?: string;
  windowName?: string;
};

export type RendererKeyModifier = "Alt" | "Control" | "Meta" | "Shift";

export type PackagedElectronLaunchOptions = {
  networkMode?: "offline" | "online";
};

type CdpTarget = {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
};

type CdpMessage = {
  error?: { code: number; message: string };
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
};

type PendingCommand = {
  reject: (error: Error) => void;
  resolve: (result: Record<string, unknown>) => void;
};

export class PackagedRenderer {
  readonly #events: RuntimeEvent[];
  readonly opened: Promise<void>;
  readonly #pending = new Map<number, PendingCommand>();
  readonly #requestUrls = new Map<
    string,
    Pick<RuntimeEvent, "url" | "method" | "operationType">
  >();
  readonly #socket: WebSocket;
  readonly #targetId: string;
  #closed = false;
  #networkReady = false;
  #nextCommandId = 1;
  #runtimeReady = false;
  #url: string;

  constructor(target: CdpTarget, events: RuntimeEvent[]) {
    if (!target.id || !target.webSocketDebuggerUrl) {
      throw new Error("Electron exposed an invalid renderer CDP target");
    }
    this.#events = events;
    this.#targetId = target.id;
    this.#url = target.url ?? "";
    this.#socket = new WebSocket(target.webSocketDebuggerUrl);
    this.opened = new Promise<void>((resolve, reject) => {
      this.#socket.addEventListener("open", () => resolve(), { once: true });
      this.#socket.addEventListener(
        "error",
        () => reject(new Error("Renderer CDP connection failed")),
        { once: true },
      );
    });
    this.#socket.addEventListener("message", (event) => {
      this.#handleMessage(String(event.data));
    });
    this.#socket.addEventListener("close", () => {
      this.#closed = true;
      const error = new Error(
        `Renderer CDP target ${this.#targetId} closed unexpectedly`,
      );
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  get url(): string {
    return this.#url;
  }

  get runtimeReady(): boolean {
    return this.#runtimeReady;
  }

  async initializeNetworkTelemetry(): Promise<void> {
    if (this.#networkReady) return;
    await this.#send("Network.enable");
    this.#networkReady = true;
  }

  async initialize(): Promise<void> {
    if (this.#runtimeReady) return;
    await this.opened;
    await this.initializeNetworkTelemetry();
    await Promise.all([
      this.#send("Runtime.enable"),
      this.#send("Page.enable"),
    ]);
    this.#runtimeReady = true;
  }

  async evaluate<Result, Argument = undefined>(
    callback: (argument: Argument) => Result | Promise<Result>,
    argument?: Argument,
  ): Promise<Result> {
    const serializedArgument =
      argument === undefined ? "" : JSON.stringify(argument);
    const response = await this.#send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `(${callback.toString()})(${serializedArgument})`,
      returnByValue: true,
      userGesture: true,
    });
    const exceptionDetails = response.exceptionDetails as
      | {
          exception?: { description?: string };
          text?: string;
        }
      | undefined;
    if (exceptionDetails) {
      throw new Error(
        exceptionDetails.exception?.description ??
          exceptionDetails.text ??
          "Renderer evaluation failed",
      );
    }
    return (response.result as { value?: Result } | undefined)?.value as Result;
  }

  async identity(): Promise<RendererIdentity> {
    return this.evaluate(async () => {
      const desktopWindow = globalThis as typeof globalThis & {
        __apis?: { ui?: { isActiveTab?: () => Promise<boolean> } };
        __appInfo?: { viewId?: string; windowName?: string };
      };
      let active = false;
      if (desktopWindow.__apis?.ui?.isActiveTab) {
        try {
          active = await desktopWindow.__apis.ui.isActiveTab();
        } catch {
          active = false;
        }
      }
      return {
        active,
        viewId: desktopWindow.__appInfo?.viewId,
        windowName: desktopWindow.__appInfo?.windowName,
      };
    });
  }

  async captureScreenshot(): Promise<Buffer> {
    const response = await this.#send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    });
    if (typeof response.data !== "string") {
      throw new Error("Renderer screenshot did not return PNG data");
    }
    return Buffer.from(response.data, "base64");
  }

  async clickAt(x: number, y: number): Promise<void> {
    for (const type of ["mousePressed", "mouseReleased"] as const) {
      await this.#send("Input.dispatchMouseEvent", {
        button: "left",
        clickCount: 1,
        type,
        x,
        y,
      });
    }
  }

  async insertText(text: string): Promise<void> {
    await this.#send("Input.insertText", { text });
  }

  async navigate(url: string): Promise<void> {
    const response = await this.#send("Page.navigate", { url });
    if (typeof response.errorText === "string" && response.errorText) {
      throw new Error(`Renderer navigation failed: ${response.errorText}`);
    }
  }

  async press(
    key: string,
    modifiers: readonly RendererKeyModifier[] = [],
  ): Promise<void> {
    const modifierBits = modifiers.reduce(
      (bits, modifier) =>
        bits + { Alt: 1, Control: 2, Meta: 4, Shift: 8 }[modifier],
      0,
    );
    const code =
      key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key;
    for (const type of ["keyDown", "keyUp"] as const) {
      await this.#send("Input.dispatchKeyEvent", {
        code,
        key,
        modifiers: modifierBits,
        type,
      });
    }
  }

  async reload(): Promise<void> {
    await this.#send("Page.reload", { ignoreCache: false });
  }

  async setOffline(offline: boolean): Promise<void> {
    await this.#send("Network.emulateNetworkConditions", {
      connectionType: offline ? "none" : "wifi",
      downloadThroughput: offline ? 0 : -1,
      latency: 0,
      offline,
      uploadThroughput: offline ? 0 : -1,
    });
  }

  async emulateColorScheme(
    colorScheme: "dark" | "light" | null,
  ): Promise<void> {
    await this.#send("Emulation.setEmulatedMedia", {
      features:
        colorScheme === null
          ? []
          : [{ name: "prefers-color-scheme", value: colorScheme }],
      media: "",
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.close();
  }

  async #send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    await this.opened;
    if (this.#closed) {
      throw new Error(`Renderer CDP target ${this.#targetId} is closed`);
    }
    const id = this.#nextCommandId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.#pending.set(id, { reject, resolve });
      this.#socket.send(JSON.stringify({ id, method, params }));
    });
  }

  #handleMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch (error) {
      this.#events.push({
        level: "error",
        source: "pageerror",
        text: `Invalid renderer CDP message: ${String(error)}`,
        url: this.#url,
      });
      return;
    }

    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(
          new Error(
            `CDP command failed (${message.error.code}): ${message.error.message}`,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }
    if (!message.method) return;

    this.#recordRuntimeEvent(message.method, message.params ?? {});
  }

  #recordRuntimeEvent(method: string, params: Record<string, unknown>): void {
    if (method === "Page.frameNavigated") {
      const frame = params.frame as { parentId?: string; url?: string };
      if (!frame.parentId && frame.url) this.#url = frame.url;
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const request = params.request as {
        url?: string;
        method?: string;
        postData?: string;
      };
      if (typeof params.requestId === "string" && request.url) {
        let operationType: string | undefined;
        try {
          const body = JSON.parse(request.postData ?? "null");
          if (typeof body?.query === "string") {
            operationType = body.query.match(
              /^\s*(query|mutation|subscription)\b/,
            )?.[1];
          }
        } catch {
          // Unclassified requests remain failures. Never retain request bodies
          // or credentials merely to distinguish a cancelled read from a write.
        }
        this.#requestUrls.set(params.requestId, {
          url: request.url,
          method: request.method,
          operationType,
        });
      }
      return;
    }
    if (method === "Network.loadingFinished") {
      if (typeof params.requestId === "string") {
        this.#requestUrls.delete(params.requestId);
      }
      return;
    }
    if (method === "Network.loadingFailed") {
      const requestId = String(params.requestId ?? "");
      this.#events.push({
        level: "error",
        source: "requestfailed",
        text: String(params.errorText ?? "unknown request failure"),
        url: this.#requestUrls.get(requestId)?.url ?? this.#url,
        method: this.#requestUrls.get(requestId)?.method,
        operationType: this.#requestUrls.get(requestId)?.operationType,
      });
      this.#requestUrls.delete(requestId);
      return;
    }
    if (
      method === "Runtime.consoleAPICalled" &&
      (params.type === "error" || params.type === "assert")
    ) {
      const args = (params.args ?? []) as {
        description?: string;
        value?: unknown;
      }[];
      const stackTrace = params.stackTrace as
        { callFrames?: { url?: string }[] } | undefined;
      this.#events.push({
        level: String(params.type),
        source: "console",
        text: args
          .map((argument) =>
            argument.value === undefined
              ? (argument.description ?? "")
              : String(argument.value),
          )
          .join(" "),
        url: stackTrace?.callFrames?.[0]?.url ?? this.#url,
      });
      return;
    }
    if (method === "Runtime.exceptionThrown") {
      const details = params.exceptionDetails as {
        exception?: { description?: string };
        stackTrace?: { callFrames?: { url?: string }[] };
        text?: string;
        url?: string;
      };
      this.#events.push({
        level: "error",
        source: "pageerror",
        text:
          details.exception?.description ??
          details.text ??
          "unknown renderer exception",
        url:
          details.url ?? details.stackTrace?.callFrames?.[0]?.url ?? this.#url,
      });
    }
  }
}

export function packagedEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete env.BUILD_TYPE;
  delete env.BUILD_TYPE_OVERRIDE;
  delete env.DEV_SERVER_URL;
  delete env.ELECTRON_E2E;
  delete env.ELECTRON_E2E_PACKAGE_TYPE;
  delete env.ELECTRON_E2E_UPDATE_FEED;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.E2E_USER_EMAIL;
  delete env.E2E_USER_PASSWORD;
  delete env.MYOXUS_API_URL;
  delete env.MYOXUS_DESKTOP_TEST_ENVIRONMENT_ID;
  delete env.MYOXUS_ELECTRON_EXECUTABLE;
  delete env.MYOXUS_ELECTRON_LAUNCH_ARGUMENTS;
  delete env.MYOXUS_ELECTRON_LAUNCH_COMMAND;
  delete env.MYOXUS_ELECTRON_RELEASE_EVIDENCE;
  delete env.MYOXUS_FRONTEND_URL;
  delete env.MYOXUS_RELEASE_ARCH;
  delete env.MYOXUS_RELEASE_CHANNEL;
  delete env.MYOXUS_RELEASE_FORMAT;
  delete env.MYOXUS_RELEASE_PACKAGE_PATH;
  delete env.MYOXUS_RELEASE_PLATFORM;
  delete env.MYOXUS_RELEASE_SOURCE_COMMIT;
  delete env.NODE_OPTIONS;
  return {
    ...env,
    CI: "1",
    NODE_ENV: "production",
    SKIP_ONBOARDING: "1",
    ...overrides,
  };
}

function packagedLaunchArguments(): string[] {
  const raw = process.env.MYOXUS_ELECTRON_LAUNCH_ARGUMENTS?.trim();
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (
    !Array.isArray(parsed) ||
    parsed.some((argument) => typeof argument !== "string")
  ) {
    throw new Error(
      "MYOXUS_ELECTRON_LAUNCH_ARGUMENTS must be a JSON string array",
    );
  }
  if (parsed.includes("--no-sandbox")) {
    throw new Error("--no-sandbox is forbidden in packaged runtime evidence");
  }
  return parsed;
}

type PackagedLaunch = {
  command: string;
  directExecutable?: string;
};

async function resolveCommand(command: string): Promise<string> {
  if (command.includes(path.sep)) {
    const resolved = path.resolve(command);
    await access(resolved, constants.X_OK);
    return resolved;
  }
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through PATH; absence is reported once all entries are checked.
    }
  }
  throw new Error(
    `MYOXUS_ELECTRON_LAUNCH_COMMAND is not executable: ${command}`,
  );
}

export async function resolvePackagedLaunch(): Promise<PackagedLaunch> {
  const configuredExecutable = process.env.MYOXUS_ELECTRON_EXECUTABLE?.trim();
  const configuredCommand = process.env.MYOXUS_ELECTRON_LAUNCH_COMMAND?.trim();
  if (!configuredExecutable && !configuredCommand) {
    throw new Error(
      "MYOXUS_ELECTRON_EXECUTABLE or MYOXUS_ELECTRON_LAUNCH_COMMAND is required",
    );
  }

  if (configuredExecutable) {
    const executablePath = path.resolve(configuredExecutable);
    await access(executablePath, constants.X_OK);
    const executableStat = await stat(executablePath);
    if (!executableStat.isFile()) {
      throw new Error(
        `MYOXUS_ELECTRON_EXECUTABLE is not a file: ${executablePath}`,
      );
    }
    return { command: executablePath, directExecutable: executablePath };
  }

  if (process.platform !== "linux") {
    throw new Error(
      "Wrapper launch commands are supported only on Linux; other targets require MYOXUS_ELECTRON_EXECUTABLE",
    );
  }
  return { command: await resolveCommand(configuredCommand!) };
}

export async function removeDirectory(directory: string): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(directory, { force: true, recursive: true });
      return;
    } catch (error) {
      failure = error;
      await delay(200 * (attempt + 1));
    }
  }
  throw failure;
}

async function rendererAttestation(
  page: PackagedRenderer,
): Promise<RendererAttestation> {
  return page.evaluate(() => {
    const desktopWindow = window as Window & {
      __apis?: {
        sharedStorage?: { getAllGlobalState?: unknown };
        ui?: { isActiveTab?: unknown };
        updater?: { currentVersion?: unknown };
        worker?: { connectWorker?: unknown };
      };
      __appInfo?: RendererAttestation["appInfo"];
      process?: unknown;
      require?: unknown;
    };
    return {
      appInfo: desktopWindow.__appInfo ?? null,
      bridgeMethods: {
        currentVersion: typeof desktopWindow.__apis?.updater?.currentVersion,
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
    };
  });
}

const expectedOfflinePaths = new Set([
  "/api/auth/session",
  "/api/branding/app-server.json",
  "/api/branding/theme.css",
  "/api/telemetry/collect",
  "/graphql",
]);

function isExpectedOfflineUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol === "assets:" &&
      (url.pathname === "/api/branding/app-server.json" ||
        url.pathname === "/api/branding/theme.css")
    ) {
      return true;
    }
    return (
      url.hostname === "unconfigured.example.invalid" &&
      expectedOfflinePaths.has(url.pathname)
    );
  } catch {
    return false;
  }
}

function isOfflineTransportError(text: string): boolean {
  return /net::ERR_(?:FAILED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|UNEXPECTED)/.test(
    text,
  );
}

export function classifyRuntimeEvents(events: readonly RuntimeEvent[]): {
  expectedOffline: RuntimeEvent[];
  unexpected: RuntimeEvent[];
} {
  const expectedOfflineRequests = events.filter(
    (event) =>
      event.source === "requestfailed" &&
      isExpectedOfflineUrl(event.url) &&
      isOfflineTransportError(event.text),
  );
  const hasExpectedOfflineRequest = expectedOfflineRequests.length > 0;
  const expectedOfflineConsole = events.filter(
    (event) =>
      event.source === "console" &&
      hasExpectedOfflineRequest &&
      /^Failed to load resource: net::ERR_(?:INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|UNEXPECTED)$/.test(
        event.text,
      ),
  );
  const allowed = new Set([
    ...expectedOfflineRequests,
    ...expectedOfflineConsole,
  ]);
  return {
    expectedOffline: [...allowed],
    unexpected: events.filter((event) => !allowed.has(event)),
  };
}

function packageResourcesPath(executablePath: string): string {
  if (process.platform === "darwin") {
    return path.resolve(path.dirname(executablePath), "../Resources");
  }
  return path.join(path.dirname(executablePath), "resources");
}

type LinuxPackagedProcess = {
  executablePath: string;
  pid: number;
  resourcesPath: string;
};

type ProcessRelation = {
  processGroup: number;
  parent: number;
};

async function processTable(): Promise<Map<number, ProcessRelation>> {
  const table = new Map<number, ProcessRelation>();
  for (const entry of await readdir("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const line = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = line.slice(line.lastIndexOf(")") + 2).split(/\s+/);
      const parent = Number(fields[1]);
      const processGroup = Number(fields[2]);
      if (Number.isInteger(parent) && Number.isInteger(processGroup)) {
        table.set(pid, { parent, processGroup });
      }
    } catch {
      // Processes can disappear while /proc is being sampled.
    }
  }
  return table;
}

function descendantPids(
  rootPid: number,
  table: Map<number, ProcessRelation>,
): number[] {
  const result = [
    rootPid,
    ...[...table]
      .filter(([, relation]) => relation.processGroup === rootPid)
      .map(([pid]) => pid),
  ];
  for (const parent of result) {
    for (const [pid, relation] of table) {
      if (relation.parent === parent && !result.includes(pid)) result.push(pid);
    }
  }
  return result;
}

async function linuxPackagedProcess(
  wrapperPid: number,
): Promise<LinuxPackagedProcess> {
  const deadline = Date.now() + WINDOW_TIMEOUT;
  let lastFailure: unknown;
  while (Date.now() < deadline) {
    const pids = descendantPids(wrapperPid, await processTable());
    for (const pid of pids) {
      try {
        const commandLine = (await readFile(`/proc/${pid}/cmdline`))
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        if (commandLine.some((argument) => argument.startsWith("--type="))) {
          continue;
        }
        const executableTarget = (await readlink(`/proc/${pid}/exe`)).replace(
          / \(deleted\)$/,
          "",
        );
        const namespaceCandidates = [commandLine[0], executableTarget].filter(
          (candidate): candidate is string =>
            typeof candidate === "string" && path.isAbsolute(candidate),
        );
        for (const namespaceExecutable of namespaceCandidates) {
          try {
            const rootedExecutable = path.join(
              `/proc/${pid}/root`,
              namespaceExecutable,
            );
            const resourcesPath = packageResourcesPath(rootedExecutable);
            await Promise.all([
              access(rootedExecutable, constants.X_OK),
              access(path.join(resourcesPath, "app.asar"), constants.R_OK),
            ]);
            return { executablePath: rootedExecutable, pid, resourcesPath };
          } catch (error) {
            lastFailure = error;
          }
        }
      } catch (error) {
        lastFailure = error;
      }
    }
    await delay(100);
  }
  throw new Error(
    "Could not identify the packaged Electron main process below the launch wrapper",
    { cause: lastFailure },
  );
}

async function mainProcessAttestation(
  launch: PackagedLaunch,
  wrapperPid: number,
): Promise<MainProcessAttestation> {
  const packagedProcess =
    process.platform === "linux"
      ? await linuxPackagedProcess(wrapperPid)
      : {
          executablePath: launch.directExecutable!,
          pid: wrapperPid,
          resourcesPath: packageResourcesPath(launch.directExecutable!),
        };
  const resourcesPath = packagedProcess.resourcesPath;
  const appAsarPath = path.join(resourcesPath, "app.asar");
  await access(appAsarPath, constants.R_OK);
  const packageJson = JSON.parse(
    extractFile(appAsarPath, "package.json").toString("utf8"),
  ) as {
    main?: unknown;
    name?: unknown;
    version?: unknown;
  };
  if (
    typeof packageJson.main !== "string" ||
    typeof packageJson.name !== "string" ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error("Packaged app.asar contains invalid package metadata");
  }
  const nativeRoot = path.join(resourcesPath, "app.asar.unpacked", "dist");
  const nativeFiles = (await readdir(nativeRoot))
    .filter((entry) => entry.endsWith(".node"))
    .sort();
  return {
    appAsarPath,
    appMain: packageJson.main,
    appName: packageJson.name,
    appVersion: packageJson.version,
    configuredExecutable: launch.command,
    executableRealPath: await realpath(
      process.platform === "linux"
        ? `/proc/${packagedProcess.pid}/exe`
        : packagedProcess.executablePath,
    ),
    nativeFiles,
    packageResourcesPath: resourcesPath,
    pid: packagedProcess.pid,
    processExecutablePath:
      process.platform === "linux"
        ? `/proc/${packagedProcess.pid}/exe`
        : packagedProcess.executablePath,
    wrapperPid,
  };
}

function createRendererDiscovery(
  websocket: string,
  events: RuntimeEvent[],
): {
  close: () => void;
  findRenderer: PackagedElectronRuntime["findRenderer"];
} {
  const firstSeen = new Map<string, number>();
  const renderers = new Map<string, PackagedRenderer>();
  const targetListUrl = websocket
    .replace(/^ws:/, "http:")
    .replace(/\/devtools\/browser\/.*$/, "/json/list");

  const discover = async (): Promise<PackagedRenderer[]> => {
    const response = await fetch(targetListUrl);
    if (!response.ok) {
      throw new Error(`CDP target list returned ${response.status}`);
    }
    const targets = (await response.json()) as CdpTarget[];
    const available = new Set<string>();
    for (const target of targets) {
      if (
        target.type !== "page" ||
        !target.url?.startsWith("assets://") ||
        !target.id ||
        !target.webSocketDebuggerUrl
      ) {
        continue;
      }
      available.add(target.id);
      const seenAt = firstSeen.get(target.id) ?? Date.now();
      firstSeen.set(target.id, seenAt);
      let renderer = renderers.get(target.id);
      if (!renderer) {
        renderer = new PackagedRenderer(target, events);
        await renderer.initializeNetworkTelemetry();
        renderers.set(target.id, renderer);
      }
      // Electron publishes sandboxed targets before preload startupData exists.
      // Attaching during that interval breaks the production preload itself.
      if (Date.now() - seenAt < SANDBOX_PRELOAD_ATTACH_GRACE) continue;
      if (!renderer.runtimeReady) {
        await renderer.initialize();
      }
    }
    for (const [id, renderer] of renderers) {
      if (!available.has(id) || renderer.closed) {
        renderer.close();
        renderers.delete(id);
      }
    }
    for (const id of firstSeen.keys()) {
      if (!available.has(id)) firstSeen.delete(id);
    }
    return [...renderers.values()];
  };

  const findRenderer: PackagedElectronRuntime["findRenderer"] = async (
    predicate,
    label,
    timeout = WINDOW_TIMEOUT,
  ) => {
    const deadline = Date.now() + timeout;
    let lastFailure: unknown;
    while (Date.now() < deadline) {
      try {
        for (const renderer of await discover()) {
          if (!renderer.runtimeReady) continue;
          const identity = await renderer.identity();
          if (predicate(identity)) return renderer;
        }
      } catch (error) {
        lastFailure = error;
      }
      await delay(100);
    }
    throw new Error(`Packaged Electron did not expose its ${label} renderer`, {
      cause: lastFailure,
    });
  };

  return {
    close: () => {
      for (const renderer of renderers.values()) renderer.close();
      renderers.clear();
    },
    findRenderer,
  };
}

export async function launchPackagedElectron(
  profile: string,
  options: PackagedElectronLaunchOptions = {},
): Promise<PackagedElectronRuntime> {
  const launch = await resolvePackagedLaunch();
  await mkdir(profile, { recursive: true });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const endpoint = Promise.withResolvers<string>();
  const managed = startProcess({
    args: [
      ...packagedLaunchArguments(),
      "--host-resolver-rules=MAP unconfigured.example.invalid ~NOTFOUND",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--no-first-run",
      ...(options.networkMode === "offline"
        ? [
            "--proxy-server=http://127.0.0.1:9",
            "--proxy-bypass-list=<-loopback>",
          ]
        : []),
    ],
    command: launch.command,
    cwd: path.dirname(launch.command),
    env: packagedEnvironment(),
    stdio: "pipe",
  });
  const inspectOutput = (target: string[], chunk: Buffer | string) => {
    const value = String(chunk);
    target.push(value);
    const match = value.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) endpoint.resolve(match[1]);
  };
  managed.child.stdout?.on("data", (chunk) => inspectOutput(stdout, chunk));
  managed.child.stderr?.on("data", (chunk) => inspectOutput(stderr, chunk));
  managed.child.once("error", (error) => endpoint.reject(error));
  managed.child.once("exit", (code, signal) => {
    endpoint.reject(
      new Error(
        `Packaged Electron exited before CDP attach: ${code ?? "null"}/${signal ?? "none"}`,
      ),
    );
  });

  let closeRenderers: (() => void) | undefined;
  try {
    const websocket = await Promise.race([
      endpoint.promise,
      delay(WINDOW_TIMEOUT).then(() => {
        throw new Error("Packaged Electron did not expose a CDP endpoint");
      }),
    ]);
    const events: RuntimeEvent[] = [];
    const discovery = createRendererDiscovery(websocket, events);
    closeRenderers = discovery.close;
    const main = await mainProcessAttestation(launch, managed.child.pid!);
    const page = await discovery.findRenderer(
      (identity) =>
        identity.windowName === "main" &&
        identity.viewId?.startsWith("app-") === true &&
        identity.active,
      "active app",
    );
    const shellPage = await discovery.findRenderer(
      (identity) =>
        identity.windowName === "main" && identity.viewId === "shell",
      "shell",
    );
    return {
      closeRenderers: discovery.close,
      events,
      executablePath: launch.command,
      findRenderer: discovery.findRenderer,
      main,
      managed,
      page,
      renderer: await rendererAttestation(page),
      shell: await rendererAttestation(shellPage),
      stderr,
      stdout,
    };
  } catch (error) {
    closeRenderers?.();
    await managed.stop("packaged runtime startup failure");
    throw new Error(
      [
        error instanceof Error ? error.message : String(error),
        stderr.length > 0
          ? `Packaged Electron stderr:\n${stderr.join("")}`
          : "Packaged Electron emitted no stderr",
        stdout.length > 0
          ? `Packaged Electron stdout:\n${stdout.join("")}`
          : "Packaged Electron emitted no stdout",
      ].join("\n"),
      { cause: error },
    );
  }
}

export async function closeElectron(
  runtime: Pick<PackagedElectronRuntime, "closeRenderers" | "main" | "managed">,
): Promise<void> {
  runtime.closeRenderers();
  await runtime.managed.stop("packaged runtime smoke complete");
  await runtime.managed.completion;
  if (process.platform !== "linux") return;
  try {
    await access(`/proc/${runtime.main.pid}`, constants.F_OK);
  } catch {
    return;
  }

  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(-runtime.main.wrapperPid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await delay(100);
      try {
        await access(`/proc/${runtime.main.pid}`, constants.F_OK);
      } catch {
        return;
      }
    }
  }
  throw new Error(
    `Packaged Electron process ${runtime.main.pid} survived wrapper cleanup`,
  );
}

export async function assertPackagedElectronClassification(evidence: {
  main?: MainProcessAttestation;
  renderer: RendererAttestation;
  shell?: RendererAttestation;
}): Promise<void> {
  const { main, renderer, shell } = evidence;
  if (!main) {
    throw new Error(
      "Browser-only evidence cannot attest a packaged Electron main process",
    );
  }
  if (!shell) {
    throw new Error("Packaged Electron shell renderer evidence is missing");
  }

  expect(main.appAsarPath.replaceAll("\\", "/")).toMatch(
    /\/resources\/app[.]asar$/i,
  );
  expect(main.appMain).toMatch(/^dist\/main[.]js$/);
  expect(main.appName).toBe("myoxus-desktop");
  expect(main.appVersion).toMatch(/^\d+[.]\d+[.]\d+/);
  expect(main.pid).toBeGreaterThan(0);
  expect(main.wrapperPid).toBeGreaterThan(0);
  expect(main.nativeFiles).toEqual([
    "myoxus_crypto.node",
    "myoxus_media.node",
    expect.stringMatching(
      /^myoxus_storage[.](?:darwin|linux|win32)-[^/]+[.]node$/,
    ),
  ]);
  expect(path.isAbsolute(main.configuredExecutable)).toBe(true);
  expect(path.isAbsolute(main.executableRealPath)).toBe(true);
  expect(path.isAbsolute(main.processExecutablePath)).toBe(true);
  await Promise.all([
    access(main.appAsarPath, constants.R_OK),
    access(main.configuredExecutable, constants.X_OK),
    access(main.packageResourcesPath, constants.R_OK),
  ]);
  expect(await realpath(main.processExecutablePath)).toBe(
    main.executableRealPath,
  );

  expect(renderer.url).toMatch(/^assets:\/\/[.]\//);
  expect(renderer.appInfo).toMatchObject({
    electron: true,
    scheme: expect.stringMatching(/^myoxus(?:-(?:beta|internal|dev))?$/),
    viewId: expect.stringMatching(/^app-/),
    windowName: "main",
  });
  expect(renderer.bridgeMethods).toEqual({
    currentVersion: "function",
    getAllGlobalState: "function",
    isActiveTab: "function",
    workerConnect: "function",
  });
  expect(renderer.hasElectronUserAgent).toBe(true);
  expect(renderer.userAgent).toMatch(/Electron\/\d+[.]\d+[.]\d+/);
  expect(
    renderer.hasNodeGlobal,
    "renderer nodeIntegration must stay disabled",
  ).toBe(false);
  expect(
    renderer.hasRequireGlobal,
    "renderer require must stay unavailable",
  ).toBe(false);
  expect(shell.url).toBe("assets://./shell.html");
  expect(shell.appInfo).toMatchObject({
    electron: true,
    scheme: expect.stringMatching(/^myoxus(?:-(?:beta|internal|dev))?$/),
    viewId: "shell",
    windowName: "main",
  });
  expect(shell.hasNodeGlobal).toBe(false);
  expect(shell.hasRequireGlobal).toBe(false);
}
