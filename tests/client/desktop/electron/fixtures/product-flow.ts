// SPDX-License-Identifier: AGPL-3.0-or-later

import { createHash } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Frame,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { chromium } from "playwright";

import {
  signInViaApi,
  signOutViaApi,
} from "../../../webfrontend/shared/auth-helper";
import {
  getSmokeWorkspaceId,
  smokeGql,
  waitForWorkspaceReady,
} from "../../../webfrontend/shared/workspace-helper";
import {
  classifyRuntimeEvents,
  type PackagedRenderer,
  type RuntimeEvent,
} from "./packaged-runtime";

const REPO_ROOT = path.resolve(__dirname, "../../../../..");
const EVIDENCE_ROOT = path.resolve(
  process.env.MYOXUS_ELECTRON_RELEASE_EVIDENCE ??
    path.join(
      REPO_ROOT,
      "output/electron-build/P-ELECTRON-BUILD-12/product-flow",
    ),
);

const REQUIRED_ENVIRONMENT = [
  "MYOXUS_API_URL",
  "MYOXUS_FRONTEND_URL",
  "E2E_USER_EMAIL",
  "E2E_USER_PASSWORD",
] as const;

const REQUIRED_RELEASE_IDENTITY = [
  "MYOXUS_RELEASE_ARCH",
  "MYOXUS_RELEASE_CHANNEL",
  "MYOXUS_RELEASE_FORMAT",
  "MYOXUS_RELEASE_PACKAGE_PATH",
  "MYOXUS_RELEASE_PLATFORM",
  "MYOXUS_RELEASE_SOURCE_COMMIT",
  "MYOXUS_DESKTOP_TEST_ENVIRONMENT_ID",
] as const;

export type ProductFlowEnvironment = {
  apiUrl: string;
  email: string;
  frontendUrl: string;
  password: string;
};

export type ProductFlowServerInfo = {
  flavor: string;
  initialized: boolean;
  version: string;
};

export type ProductFlowReleaseIdentity = {
  arch: "arm64" | "x64";
  channel: "beta" | "internal" | "stable";
  environmentId: string;
  format: "deb" | "dmg" | "flatpak" | "nsis" | "rpm" | "zip";
  packagePath: string;
  platform: "linux" | "macos" | "windows";
  sourceCommit: string;
};

export type BrowserRuntimeEvent = {
  method?: string;
  operationName?: string;
  operationType?: "mutation" | "query" | "subscription";
  resourceType?: string;
  source: "console" | "pageerror" | "requestfailed";
  text: string;
  url: string;
};

export type BrowserRuntimeEventClassification = {
  expectedQueryAborts: BrowserRuntimeEvent[];
  unexpected: BrowserRuntimeEvent[];
};

export type RuntimeEventClassification = {
  expectedOffline: RuntimeEvent[];
  unexpected: RuntimeEvent[];
};

export type WebSession = {
  browser: Browser;
  context: BrowserContext;
  cookies: string[];
  events: BrowserRuntimeEvent[];
  page: Page;
  signOut: () => Promise<void>;
};

type DeleteDocumentsResult = {
  failed: number;
  forbidden: number;
};

function requiredValue(name: (typeof REQUIRED_ENVIRONMENT)[number]): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required for the packaged Electron product-flow gate; provision credentials with build/scripts/test/seed-test-users.sh`,
    );
  }
  return value;
}

function normalizedHttpUrl(name: string, value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${name} must use http or https: ${value}`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

export function requireProductFlowEnvironment(): ProductFlowEnvironment {
  for (const name of REQUIRED_ENVIRONMENT) requiredValue(name);
  return {
    apiUrl: normalizedHttpUrl(
      "MYOXUS_API_URL",
      requiredValue("MYOXUS_API_URL"),
    ),
    email: requiredValue("E2E_USER_EMAIL"),
    frontendUrl: normalizedHttpUrl(
      "MYOXUS_FRONTEND_URL",
      requiredValue("MYOXUS_FRONTEND_URL"),
    ),
    password: requiredValue("E2E_USER_PASSWORD"),
  };
}

export function requireProductFlowReleaseIdentity(): ProductFlowReleaseIdentity {
  const values = Object.fromEntries(
    REQUIRED_RELEASE_IDENTITY.map((name) => [name, process.env[name]?.trim()]),
  );
  for (const name of REQUIRED_RELEASE_IDENTITY) {
    if (!values[name]) {
      throw new Error(
        `${name} is required for package-bound product-flow evidence`,
      );
    }
  }
  if (!/^[0-9a-f]{40,64}$/.test(values.MYOXUS_RELEASE_SOURCE_COMMIT!)) {
    throw new Error("MYOXUS_RELEASE_SOURCE_COMMIT must be a Git commit digest");
  }
  if (!/^(?:arm64|x64)$/.test(values.MYOXUS_RELEASE_ARCH!)) {
    throw new Error("MYOXUS_RELEASE_ARCH must be arm64 or x64");
  }
  if (!/^(?:beta|internal|stable)$/.test(values.MYOXUS_RELEASE_CHANNEL!)) {
    throw new Error("MYOXUS_RELEASE_CHANNEL has an unsupported value");
  }
  if (
    !/^(?:deb|dmg|flatpak|nsis|rpm|zip)$/.test(values.MYOXUS_RELEASE_FORMAT!)
  ) {
    throw new Error("MYOXUS_RELEASE_FORMAT has an unsupported value");
  }
  if (!/^(?:linux|macos|windows)$/.test(values.MYOXUS_RELEASE_PLATFORM!)) {
    throw new Error("MYOXUS_RELEASE_PLATFORM has an unsupported value");
  }
  if (
    !/^[A-Za-z0-9._:-]{3,128}$/.test(values.MYOXUS_DESKTOP_TEST_ENVIRONMENT_ID!)
  ) {
    throw new Error("MYOXUS_DESKTOP_TEST_ENVIRONMENT_ID is malformed");
  }
  const packagePath = path.resolve(values.MYOXUS_RELEASE_PACKAGE_PATH!);
  return {
    arch: values.MYOXUS_RELEASE_ARCH as ProductFlowReleaseIdentity["arch"],
    channel:
      values.MYOXUS_RELEASE_CHANNEL as ProductFlowReleaseIdentity["channel"],
    environmentId: values.MYOXUS_DESKTOP_TEST_ENVIRONMENT_ID!,
    format:
      values.MYOXUS_RELEASE_FORMAT as ProductFlowReleaseIdentity["format"],
    packagePath,
    platform:
      values.MYOXUS_RELEASE_PLATFORM as ProductFlowReleaseIdentity["platform"],
    sourceCommit: values.MYOXUS_RELEASE_SOURCE_COMMIT!,
  };
}

export async function fileSha256(file: string): Promise<string> {
  await access(file);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

export async function requireProductFlowServerInfo(
  request: APIRequestContext,
  environment: ProductFlowEnvironment,
): Promise<ProductFlowServerInfo> {
  const response = await request.get(`${environment.apiUrl}/info`, {
    timeout: 15_000,
  });
  if (!response.ok()) {
    throw new Error(
      `Desktop product-flow server info failed: HTTP ${response.status()} ${await response.text()}`,
    );
  }
  const value = (await response.json()) as Partial<ProductFlowServerInfo>;
  if (
    value.flavor !== "myoxus-rust" ||
    value.initialized !== true ||
    typeof value.version !== "string" ||
    !/^\d+[.]\d+[.]\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)
  ) {
    throw new Error(
      `Desktop product-flow server is not an initialized versioned Myoxus server: ${JSON.stringify(value)}`,
    );
  }
  const expectedServerVersion = readFileSync(
    path.join(REPO_ROOT, "server/Cargo.toml"),
    "utf8",
  )
    .split("[workspace.package]", 2)[1]
    ?.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (!expectedServerVersion) {
    throw new Error(
      "Desktop product-flow source has no server release version",
    );
  }
  if (value.version !== expectedServerVersion) {
    throw new Error(
      `Desktop product-flow server version ${value.version} differs from source server contract ${expectedServerVersion}`,
    );
  }
  return {
    flavor: value.flavor,
    initialized: value.initialized,
    version: value.version,
  };
}

export function productFlowProfile(testInfo: TestInfo): string {
  const key = createHash("sha256")
    .update(testInfo.testId)
    .digest("hex")
    .slice(0, 16);
  return path.join(EVIDENCE_ROOT, "profiles", key);
}

function collectBrowserEvents(page: Page): BrowserRuntimeEvent[] {
  const events: BrowserRuntimeEvent[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      events.push({
        source: "console",
        text: message.text(),
        url: message.location().url || page.url(),
      });
    }
  });
  page.on("pageerror", (error) => {
    events.push({
      source: "pageerror",
      text: error.message,
      url: page.url(),
    });
  });
  page.on("requestfailed", (request) => {
    let operationName: string | undefined;
    let operationType: BrowserRuntimeEvent["operationType"];
    try {
      const body = request.postDataJSON() as { query?: unknown } | null;
      if (typeof body?.query === "string") {
        const operation = body.query.match(
          /\b(mutation|query|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/,
        );
        operationType = operation?.[1] as
          BrowserRuntimeEvent["operationType"] | undefined;
        operationName = operation?.[2];
      }
    } catch {
      // An unparseable request stays unclassified and therefore fails the gate.
    }
    events.push({
      method: request.method(),
      operationName,
      operationType,
      resourceType: request.resourceType(),
      source: "requestfailed",
      text: request.failure()?.errorText ?? "unknown request failure",
      url: request.url(),
    });
  });
  return events;
}

export function classifyWebRuntimeEvents(
  events: readonly BrowserRuntimeEvent[],
): BrowserRuntimeEventClassification {
  const expectedQueryAborts = events.filter((event) => {
    if (
      event.source !== "requestfailed" ||
      event.text !== "net::ERR_ABORTED" ||
      event.method !== "POST" ||
      event.operationType !== "query" ||
      !event.operationName
    ) {
      return false;
    }
    try {
      return new URL(event.url).pathname === "/graphql";
    } catch {
      return false;
    }
  });
  const expected = new Set(expectedQueryAborts);
  return {
    expectedQueryAborts,
    unexpected: events.filter((event) => !expected.has(event)),
  };
}

async function injectCookies(
  context: BrowserContext,
  frontendUrl: string,
  rawCookies: string[],
): Promise<void> {
  const cookies = rawCookies.map((raw) => {
    const [nameValue] = raw.split(";", 1);
    const [name, ...value] = nameValue.split("=");
    if (!name?.trim() || value.length === 0) {
      throw new Error("Authentication returned a malformed Set-Cookie header");
    }
    return {
      name: name.trim(),
      url: frontendUrl,
      value: value.join("=").trim(),
    };
  });
  if (cookies.length === 0) {
    throw new Error("Authentication returned no cookies for the Web client");
  }
  await context.addCookies(cookies);
}

export async function openAuthenticatedWebSession(
  request: APIRequestContext,
  environment: ProductFlowEnvironment,
): Promise<WebSession> {
  const cookies = await signInViaApi(
    request,
    environment.apiUrl,
    environment.email,
    environment.password,
  );
  const browser = await chromium.launch();
  const context = await browser.newContext();
  await injectCookies(context, environment.frontendUrl, cookies);
  const page = await context.newPage();
  const events = collectBrowserEvents(page);
  return {
    browser,
    context,
    cookies,
    events,
    page,
    signOut: () => signOutViaApi(request, environment.apiUrl, cookies),
  };
}

export async function seededWorkspace(
  request: APIRequestContext,
  environment: ProductFlowEnvironment,
  cookies: string[],
): Promise<{ id: string; initialized: boolean; name: string | null }> {
  const id = await getSmokeWorkspaceId(
    request,
    `${environment.apiUrl}/graphql`,
    cookies,
  );
  const data = await smokeGql<{
    workspace: {
      id: string;
      initialized: boolean;
      name: string | null;
    } | null;
  }>(
    request,
    `${environment.apiUrl}/graphql`,
    cookies,
    `query ElectronProductFlowWorkspace($id: String!) {
      workspace(id: $id) { id initialized name }
    }`,
    { id },
  );
  if (!data.workspace?.initialized) {
    throw new Error(
      `Seeded workspace ${id} is absent or not initialized for the configured user`,
    );
  }
  return data.workspace;
}

export async function openWebWorkspace(
  session: WebSession,
  environment: ProductFlowEnvironment,
  workspaceId: string,
): Promise<void> {
  await session.page.goto(
    `${environment.frontendUrl}/workspace/${workspaceId}/all`,
    { timeout: 30_000, waitUntil: "load" },
  );
  await waitForWorkspaceReady(session.page, { allDocs: true, timeout: 30_000 });
}

async function navigateClientRoute(
  renderer: PackagedRenderer,
  route: string,
): Promise<void> {
  const target = await renderer.evaluate(
    (nextRoute) => new URL(nextRoute, location.href).href,
    route,
  );
  await renderer.navigate(target);
  await expect
    .poll(
      () => renderer.evaluate(() => `${location.pathname}${location.search}`),
      {
        message: `Electron must navigate to the requested client route ${route}`,
        timeout: 20_000,
      },
    )
    .toBe(route);
}

type RendererElementProbe = {
  count: number;
  enabled: boolean;
  text: string;
  value: string | null;
  visible: boolean;
  x: number;
  y: number;
};

async function probeRendererElement(
  renderer: PackagedRenderer,
  selector: string,
  text?: string,
): Promise<RendererElementProbe> {
  return renderer.evaluate(
    ({ selector, text }) => {
      const matches: Element[] = [];
      const visit = (root: Document | Element | ShadowRoot) => {
        matches.push(...root.querySelectorAll(selector));
        for (const element of root.querySelectorAll("*")) {
          if (element.shadowRoot) visit(element.shadowRoot);
        }
      };
      visit(document);
      const filtered = text
        ? matches.filter((element) => element.textContent?.includes(text))
        : matches;
      const visible = filtered.filter((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });
      const rect = visible[0]?.getBoundingClientRect();
      return {
        count: filtered.length,
        enabled: Boolean(
          visible[0] &&
          !visible[0].hasAttribute("disabled") &&
          visible[0].getAttribute("aria-disabled") !== "true",
        ),
        text: filtered[0]?.textContent ?? "",
        value:
          filtered[0]?.tagName === "INPUT"
            ? (filtered[0] as HTMLInputElement).value
            : null,
        visible: visible.length === 1,
        x: rect ? rect.left + rect.width / 2 : 0,
        y: rect ? rect.top + rect.height / 2 : 0,
      };
    },
    { selector, text },
  );
}

async function waitForRendererElement(
  renderer: PackagedRenderer,
  selector: string,
  options: { message: string; text?: string; timeout?: number },
): Promise<RendererElementProbe> {
  let probe: RendererElementProbe | undefined;
  try {
    await expect
      .poll(
        async () => {
          probe = await probeRendererElement(renderer, selector, options.text);
          return probe.count === 1 && probe.visible && probe.enabled;
        },
        { message: options.message, timeout: options.timeout ?? 20_000 },
      )
      .toBe(true);
  } catch (error) {
    throw new Error(
      `${options.message}; selector=${selector}; lastProbe=${JSON.stringify(probe)}`,
      { cause: error },
    );
  }
  return probe!;
}

async function clickRendererElement(
  renderer: PackagedRenderer,
  selector: string,
  options: { message: string; text?: string; timeout?: number },
): Promise<void> {
  const element = await waitForRendererElement(renderer, selector, options);
  await renderer.clickAt(element.x, element.y);
}

async function fillRendererInput(
  renderer: PackagedRenderer,
  selector: string,
  value: string,
  message: string,
): Promise<void> {
  await clickRendererElement(renderer, selector, { message });
  await renderer.press("a", [
    process.platform === "darwin" ? "Meta" : "Control",
  ]);
  await renderer.press("Backspace");
  await renderer.insertText(value);
  await expect
    .poll(async () => (await probeRendererElement(renderer, selector)).value, {
      message: `${message}: value was not committed`,
      timeout: 5_000,
    })
    .toBe(value);
}

function documentEditor(page: Page, docId: string) {
  return page.getByTestId(`editor-${docId}`);
}

async function focusVirgultumLine(
  renderer: PackagedRenderer,
  docId: string,
  paragraphText: string,
): Promise<void> {
  let target: { count: number; x: number; y: number } | undefined;
  await expect
    .poll(
      async () => {
        target = await renderer.evaluate(
          ({ docId, paragraphText }) => {
            const editor = document.querySelector(
              `[data-testid="editor-${CSS.escape(docId)}"]`,
            );
            const paragraphs = editor
              ? [...editor.querySelectorAll("myoxus-paragraph")].filter(
                  (paragraph) => paragraph.textContent?.includes(paragraphText),
                )
              : [];
            const lines = paragraphs.flatMap((paragraph) => [
              ...paragraph.querySelectorAll("v-line"),
            ]);
            const rect = lines[0]?.getBoundingClientRect();
            return {
              count: lines.length,
              x: rect ? rect.left + rect.width / 2 : 0,
              y: rect ? rect.top + rect.height / 2 : 0,
            };
          },
          { docId, paragraphText },
        );
        return target.count;
      },
      {
        message: `Document ${docId} must contain exactly one line with the expected paragraph text`,
        timeout: 20_000,
      },
    )
    .toBe(1);
  await renderer.clickAt(target!.x, target!.y);
  await expect
    .poll(
      () =>
        renderer.evaluate(
          ({ docId, paragraphText }) => {
            const editor = document.querySelector(
              `[data-testid="editor-${CSS.escape(docId)}"]`,
            );
            const paragraph = editor
              ? [...editor.querySelectorAll("myoxus-paragraph")].find(
                  (candidate) => candidate.textContent?.includes(paragraphText),
                )
              : undefined;
            const line = paragraph?.querySelector("v-line");
            const anchor = getSelection()?.anchorNode;
            return Boolean(line && anchor && line.contains(anchor));
          },
          { docId, paragraphText },
        ),
      {
        message:
          "The packaged Electron flow must focus the exact target Virgultum line before typing",
        timeout: 5_000,
      },
    )
    .toBe(true);
}

async function solveCaptchaWhenPresent(
  renderer: PackagedRenderer,
): Promise<boolean> {
  await delay(500);
  const widget = await probeRendererElement(renderer, "altcha-widget");
  if (widget.count === 0) return false;
  await clickRendererElement(renderer, ".altcha-checkbox", {
    message: "Electron password login CAPTCHA checkbox must be visible",
    timeout: 15_000,
  });
  await expect
    .poll(
      () =>
        renderer.evaluate(() => {
          const current = document.querySelector("altcha-widget") as
            (HTMLElement & { getState?: () => string }) | null;
          if (
            !current &&
            /Verified|Verifiziert|Verificado|V\u00e9rifi\u00e9/i.test(
              document.body.innerText,
            )
          ) {
            return "verified";
          }
          return current?.getState?.() ?? null;
        }),
      {
        message: "Electron password login CAPTCHA must reach verified state",
        timeout: 30_000,
      },
    )
    .toBe("verified");
  return true;
}

export async function connectAndPasswordLogin(
  renderer: PackagedRenderer,
  environment: ProductFlowEnvironment,
  workspaceId: string,
): Promise<{ captchaSolved: boolean }> {
  const redirect = `/workspace/${workspaceId}/all`;
  await navigateClientRoute(
    renderer,
    `/sign-In?${new URLSearchParams({
      redirect_uri: redirect,
      server: environment.apiUrl,
    }).toString()}`,
  );

  const authInput = '[data-myoxus-ui-role="auth-input"] input';
  let serverStep: "connect" | "connected" | undefined;
  let serverStepProbe:
    | {
        connect: RendererElementProbe;
        continueLogin: RendererElementProbe;
        input: RendererElementProbe;
        pathname: string;
      }
    | undefined;
  await expect
    .poll(
      async () => {
        const [connect, continueLogin, input, pathname] = await Promise.all([
          probeRendererElement(
            renderer,
            '[data-testid="connect-standalone-button"]',
          ),
          probeRendererElement(
            renderer,
            '[data-testid="continue-login-button"]',
          ),
          probeRendererElement(renderer, authInput),
          renderer.evaluate(() => location.pathname),
        ]);
        serverStepProbe = { connect, continueLogin, input, pathname };
        if (
          connect.count === 1 &&
          connect.visible &&
          connect.enabled &&
          input.value === environment.apiUrl
        ) {
          serverStep = "connect";
        } else if (
          continueLogin.count === 1 &&
          continueLogin.visible &&
          continueLogin.enabled
        ) {
          serverStep = "connected";
        }
        return serverStep !== undefined;
      },
      {
        message:
          "The standalone route must expose its prefilled connect action or the connected password-login step",
        timeout: 20_000,
      },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `The standalone route did not reach a valid server step; lastProbe=${JSON.stringify(serverStepProbe)}`,
        { cause: error },
      );
    });
  if (serverStep === "connect") {
    await clickRendererElement(
      renderer,
      '[data-testid="connect-standalone-button"]',
      { message: "Standalone connect button must be interactive" },
    );
  }

  await fillRendererInput(
    renderer,
    authInput,
    environment.email,
    "Password-login email input must be interactive",
  );
  await clickRendererElement(
    renderer,
    '[data-testid="continue-login-button"]',
    {
      message: "Password-login continue button must be interactive",
    },
  );

  await waitForRendererElement(renderer, '[data-testid="password-input"]', {
    message: "Password input must be visible",
  });
  const captchaSolved = await solveCaptchaWhenPresent(renderer);
  await fillRendererInput(
    renderer,
    '[data-testid="password-input"] input, input[data-testid="password-input"]',
    environment.password,
    "Password input must be interactive",
  );
  await clickRendererElement(renderer, '[data-testid="sign-in-button"]', {
    message: "Password sign-in button must be interactive",
    timeout: 30_000,
  });

  await expect
    .poll(() => renderer.evaluate(() => location.pathname), {
      message: "Electron password login must open the seeded workspace",
      timeout: 30_000,
    })
    .toContain(`/workspace/${workspaceId}/all`);
  await waitForRendererElement(renderer, '[data-testid="main-container"]', {
    message: "Electron workspace main container must be visible",
    timeout: 30_000,
  });
  await waitForRendererElement(
    renderer,
    '[data-testid="sidebar-new-page-button"]',
    {
      message: "Electron new-document control must be visible",
      timeout: 30_000,
    },
  );
  return { captchaSolved };
}

export async function createElectronDocument(
  renderer: PackagedRenderer,
  title: string,
  initialContent: string,
): Promise<string> {
  await clickRendererElement(
    renderer,
    '[data-testid="sidebar-new-page-button"]',
    { message: "Electron new-document control must be interactive" },
  );
  let visibleEditorIds: string[] = [];
  await expect
    .poll(
      async () => {
        visibleEditorIds = await renderer.evaluate(() =>
          [...document.querySelectorAll('[data-testid^="editor-"]')]
            .filter((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                style.display !== "none" &&
                style.visibility !== "hidden"
              );
            })
            .map((element) => element.getAttribute("data-testid") ?? ""),
        );
        return visibleEditorIds.length;
      },
      {
        message:
          "Electron new-document action must open exactly one visible Virgultum editor",
        timeout: 20_000,
      },
    )
    .toBe(1);
  const editorTestId = visibleEditorIds[0];
  const docId = editorTestId?.replace(/^editor-/, "");
  if (!docId || editorTestId === docId) {
    throw new Error(
      `Could not derive the created document id from visible editors ${JSON.stringify(visibleEditorIds)}`,
    );
  }

  const editorSelector = `[data-testid="editor-${docId}"]`;
  await waitForRendererElement(renderer, editorSelector, {
    message: `Electron document editor ${docId} must be visible`,
  });
  await clickRendererElement(
    renderer,
    `${editorSelector} doc-title .doc-title-container`,
    { message: "Electron document title must be interactive" },
  );
  await waitForRendererElement(
    renderer,
    `${editorSelector} doc-title .inline-editor`,
    { message: "Electron document title editor must be visible" },
  );
  await renderer.press("a", [
    process.platform === "darwin" ? "Meta" : "Control",
  ]);
  await renderer.press("Backspace");
  await renderer.insertText(title);
  await renderer.press("ArrowDown");
  await expect
    .poll(
      () =>
        renderer.evaluate((selector) => {
          const lines = document.querySelectorAll(
            `${selector} myoxus-paragraph v-line`,
          );
          const anchor = getSelection()?.anchorNode;
          return {
            active: Boolean(lines[0] && anchor && lines[0].contains(anchor)),
            count: lines.length,
          };
        }, editorSelector),
      {
        message:
          "ArrowDown from the title must focus the existing initial paragraph",
        timeout: 5_000,
      },
    )
    .toEqual({ active: true, count: 1 });
  await renderer.insertText(initialContent);
  await waitForRendererElement(
    renderer,
    `${editorSelector} doc-title .doc-title-container`,
    {
      message: "Electron document title must commit",
      text: title,
      timeout: 20_000,
    },
  );
  await waitForRendererElement(renderer, `${editorSelector} myoxus-paragraph`, {
    message: "Electron document body must commit",
    text: initialContent,
    timeout: 20_000,
  });
  return docId;
}

export async function waitForDocumentTitleProjection(
  request: APIRequestContext,
  environment: ProductFlowEnvironment,
  cookies: string[],
  workspaceId: string,
  docId: string,
  title: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const data = await smokeGql<{
          workspace: {
            doc: { id: string; title: string | null } | null;
          } | null;
        }>(
          request,
          `${environment.apiUrl}/graphql`,
          cookies,
          `query ElectronProductFlowDocument(
            $workspaceId: String!,
            $docId: String!
          ) {
            workspace(id: $workspaceId) {
              doc(docId: $docId) { id title }
            }
          }`,
          { docId, workspaceId },
        );
        return data.workspace?.doc?.title ?? null;
      },
      {
        message:
          "The server document projection must expose the Electron-created title",
        timeout: 30_000,
      },
    )
    .toBe(title);
}

export async function waitForDocumentSyncAvailability(
  request: APIRequestContext,
  environment: ProductFlowEnvironment,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<void> {
  let lastProbe: { bytes: number; status: number } | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `${environment.apiUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}`,
          {
            headers: { cookie: cookies.join("; ") },
            timeout: 10_000,
          },
        );
        const body = await response.body();
        lastProbe = { bytes: body.length, status: response.status() };
        return response.status() === 200 && body.length > 0;
      },
      {
        message:
          "The Electron-created external document key must resolve to a non-empty server Yjs payload before another client opens it",
        timeout: 30_000,
      },
    )
    .toBe(true)
    .catch((error: unknown) => {
      throw new Error(
        `Electron-created document ${docId} did not become server-readable; lastProbe=${JSON.stringify(lastProbe)}`,
        { cause: error },
      );
    });
}

export async function openLiveDocumentInWeb(
  session: WebSession,
  docId: string,
  title: string,
  initialContent: string,
): Promise<void> {
  const row = session.page.locator(
    `[data-testid="doc-list-item"][data-doc-id="${docId}"]`,
  );
  await expect(
    row,
    "The already-open Web workspace must receive the new document without reload",
  ).toContainText(title, { timeout: 30_000 });
  const titleControl = row.getByTestId("doc-list-item-title");
  await expect(titleControl).toHaveCount(1);
  await row.click();
  await expect
    .poll(() => new URL(session.page.url()).pathname, { timeout: 20_000 })
    .toContain(`/${docId}`);
  const editor = documentEditor(session.page, docId);
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await expect(editor.locator("doc-title .doc-title-container")).toContainText(
    title,
    { timeout: 20_000 },
  );
  await expect(
    editor.locator("myoxus-paragraph").filter({ hasText: initialContent }),
  ).toBeVisible({ timeout: 20_000 });
}

export async function appendElectronContent(
  renderer: PackagedRenderer,
  docId: string,
  initialContent: string,
  content: string,
): Promise<void> {
  await focusVirgultumLine(renderer, docId, initialContent);
  const paragraphEnd = await renderer.evaluate(
    ({ docId, initialContent }) => {
      const paragraph = [
        ...document.querySelectorAll(
          `[data-testid="editor-${CSS.escape(docId)}"] myoxus-paragraph`,
        ),
      ].find((candidate) => candidate.textContent?.includes(initialContent));
      const line = paragraph?.querySelector("v-line");
      if (!line) return null;
      const range = document.createRange();
      range.selectNodeContents(line);
      const rects = [...range.getClientRects()];
      const lastRect = rects.at(-1);
      const lineRect = line.getBoundingClientRect();
      if (!lastRect) return null;
      return {
        x: Math.min(lastRect.right + 2, lineRect.right - 2),
        y: lastRect.top + lastRect.height / 2,
      };
    },
    { docId, initialContent },
  );
  if (!paragraphEnd) {
    throw new Error(
      "Could not locate the rendered end of the target paragraph",
    );
  }
  await renderer.clickAt(paragraphEnd.x, paragraphEnd.y);
  await renderer.insertText(` ${content}`);
  await clickRendererElement(
    renderer,
    `[data-testid="editor-${docId}"] doc-title .doc-title-container`,
    {
      message:
        "Electron live-sync mutation must leave the contenteditable before sync is asserted",
    },
  );
  await waitForRendererElement(
    renderer,
    `[data-testid="editor-${docId}"] myoxus-paragraph`,
    {
      message: "Electron live-sync body mutation must commit",
      text: `${initialContent} ${content}`,
      timeout: 20_000,
    },
  );
}

export async function assertWebReceivesContentWithoutReload(
  session: WebSession,
  docId: string,
  initialContent: string,
  content: string,
  mutateElectron: () => Promise<void>,
): Promise<{
  mainFrameNavigations: number;
  observedContent: string;
  urlAfter: string;
  urlBefore: string;
}> {
  const urlBefore = session.page.url();
  let mainFrameNavigations = 0;
  const onNavigation = (frame: Frame) => {
    if (frame === session.page.mainFrame()) mainFrameNavigations += 1;
  };
  session.page.on("framenavigated", onNavigation);
  try {
    await mutateElectron();
    await expect(
      documentEditor(session.page, docId)
        .locator("myoxus-paragraph")
        .filter({ hasText: `${initialContent} ${content}` }),
    ).toBeVisible({ timeout: 30_000 });
  } finally {
    session.page.off("framenavigated", onNavigation);
  }
  expect(
    mainFrameNavigations,
    "Web must expose the Electron mutation through live sync without reload",
  ).toBe(0);
  expect(session.page.url()).toBe(urlBefore);
  const observedContent = await documentEditor(session.page, docId)
    .locator("myoxus-paragraph")
    .filter({ hasText: `${initialContent} ${content}` })
    .innerText();
  return {
    mainFrameNavigations,
    observedContent,
    urlAfter: session.page.url(),
    urlBefore,
  };
}

export async function proveOfflineDocumentPersistence(
  renderer: PackagedRenderer,
  environment: ProductFlowEnvironment,
  workspaceId: string,
  docId: string,
  title: string,
  content: string,
): Promise<{
  content: string;
  docId: string;
  fetchFailure: string;
  rendererStartedOffline: boolean;
  title: string;
  url: string;
  workspaceId: string;
}> {
  const fetchFailure = await renderer.evaluate(async (apiUrl) => {
    return fetch(`${apiUrl}/api/auth/session`, { cache: "no-store" }).then(
      (response) => `unexpected HTTP ${response.status}`,
      (error: unknown) =>
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    );
  }, environment.apiUrl);
  expect(fetchFailure).toMatch(
    /Failed to fetch|ERR_(?:INTERNET_DISCONNECTED|PROXY_CONNECTION_FAILED)/i,
  );

  await expect
    .poll(() => renderer.evaluate(() => location.pathname), {
      message:
        "The packaged Electron restart must restore the last-open document without an online route repair",
      timeout: 30_000,
    })
    .toContain(`/workspace/${workspaceId}/${docId}`);
  const editorSelector = `[data-testid="editor-${docId}"]`;
  await waitForRendererElement(renderer, editorSelector, {
    message:
      "The restarted Electron profile must restore the Virgultum editor while offline",
    timeout: 30_000,
  });
  await waitForRendererElement(
    renderer,
    `${editorSelector} doc-title .doc-title-container`,
    {
      message:
        "The restarted Electron profile must render the document title offline",
      text: title,
      timeout: 30_000,
    },
  );
  await waitForRendererElement(renderer, `${editorSelector} myoxus-paragraph`, {
    message:
      "The restarted Electron profile must render the synced body from local persistence while offline",
    text: content,
    timeout: 30_000,
  });
  return {
    content,
    docId,
    fetchFailure,
    rendererStartedOffline: true,
    title,
    url: renderer.url,
    workspaceId,
  };
}

function sameNetworkAuthority(urlValue: string, baseValue: string): boolean {
  try {
    const url = new URL(urlValue);
    const base = new URL(baseValue);
    return url.hostname === base.hostname && url.port === base.port;
  } catch {
    return false;
  }
}

export function classifyOfflineRuntimeEvents(
  events: readonly RuntimeEvent[],
  apiUrl: string,
  serverId: string,
): RuntimeEventClassification {
  const packagedBootstrap = classifyOnlineRuntimeEvents(events, serverId);
  const expectedRequests = events.filter(
    (event) =>
      event.source === "requestfailed" &&
      (sameNetworkAuthority(event.url, apiUrl) ||
        event.url.startsWith(
          `assets://./_server/${encodeURIComponent(serverId)}/`,
        )) &&
      /net::ERR_(?:FAILED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|UNEXPECTED)/.test(
        event.text,
      ),
  );
  const expectedConsole = events.filter(
    (event) =>
      event.source === "console" &&
      expectedRequests.length > 0 &&
      /(?:Failed to fetch|Network request failed|net::ERR_(?:FAILED|INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NETWORK_CHANGED|PROXY_CONNECTION_FAILED))/i.test(
        event.text,
      ),
  );
  const expected = new Set([
    ...packagedBootstrap.expectedOffline,
    ...packagedBootstrap.expectedQueryAborts,
    ...expectedRequests,
    ...expectedConsole,
  ]);
  return {
    expectedOffline: [...expected],
    unexpected: events.filter((event) => !expected.has(event)),
  };
}

export function classifyOnlineRuntimeEvents(
  events: readonly RuntimeEvent[],
  serverId: string,
): RuntimeEventClassification & { expectedQueryAborts: RuntimeEvent[] } {
  const classified = classifyRuntimeEvents(events);
  // Navigation cancels obsolete GraphQL reads; aborted writes and requests
  // without parsed operation metadata must still fail the native journey.
  const expectedQueryAborts = classified.unexpected.filter(
    (event) =>
      event.source === "requestfailed" &&
      event.text === "net::ERR_ABORTED" &&
      event.method === "POST" &&
      event.operationType === "query" &&
      event.url.split("?")[0] ===
        `assets://./_server/${encodeURIComponent(serverId)}/graphql`,
  );
  return {
    ...classified,
    expectedQueryAborts,
    unexpected: classified.unexpected.filter(
      (event) => !expectedQueryAborts.includes(event),
    ),
  };
}

export async function deleteDisposableDocument(
  request: APIRequestContext,
  environment: ProductFlowEnvironment,
  cookies: string[],
  workspaceId: string,
  docId: string,
): Promise<DeleteDocumentsResult> {
  const data = await smokeGql<{
    deleteDocumentsPermanently: DeleteDocumentsResult;
  }>(
    request,
    `${environment.apiUrl}/graphql`,
    cookies,
    `mutation ElectronProductFlowCleanup(
      $input: DeleteDocumentsPermanentlyInput!
    ) {
      deleteDocumentsPermanently(input: $input) { failed forbidden }
    }`,
    { input: { docIds: [docId], workspaceId } },
  );
  expect(data.deleteDocumentsPermanently).toEqual({
    failed: 0,
    forbidden: 0,
  });

  await expect
    .poll(async () => {
      const result = await smokeGql<{
        workspace: { doc: { id: string } | null } | null;
      }>(
        request,
        `${environment.apiUrl}/graphql`,
        cookies,
        `query ElectronProductFlowCleanupProbe(
          $workspaceId: String!,
          $docId: String!
        ) {
          workspace(id: $workspaceId) { doc(docId: $docId) { id } }
        }`,
        { docId, workspaceId },
      );
      return result.workspace?.doc ?? null;
    })
    .toBeNull();
  return data.deleteDocumentsPermanently;
}

export async function writeProductFlowEvidence(
  testInfo: TestInfo,
  evidence: Record<string, unknown>,
): Promise<string> {
  const file = path.join(EVIDENCE_ROOT, "product-flow.json");
  const body = `${JSON.stringify(evidence, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body);
  await testInfo.attach("packaged-electron-product-flow", {
    body: Buffer.from(body),
    contentType: "application/json",
  });
  return file;
}

export async function writeProductFlowScreenshot(
  testInfo: TestInfo,
  name: string,
  png: Buffer,
): Promise<{ file: string; sha256: string }> {
  if (!/^[a-z0-9-]+$/.test(name) || png.length < 1_024) {
    throw new Error(`Invalid product-flow screenshot ${name}`);
  }
  const fileName = `${name}.png`;
  const file = path.join(EVIDENCE_ROOT, fileName);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, png);
  await testInfo.attach(name, { body: png, contentType: "image/png" });
  return {
    file: fileName,
    sha256: createHash("sha256").update(png).digest("hex"),
  };
}

export async function profileWasRemoved(profile: string): Promise<boolean> {
  try {
    await access(profile);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}
