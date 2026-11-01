import path from "node:path";

import type { AuthenticationRequest } from "@myoxus/desktop-api-contract";
import type { App } from "electron";

import { buildType, isDev } from "./config";
import { logger } from "./logger";
import { uiSubjects } from "./ui";
import {
  addTabWithUrl,
  getMainWindow,
  loadUrlInActiveTab,
  openUrlInHiddenWindow,
  showMainWindow,
} from "./windows-manager";

let protocol = buildType === "stable" ? "myoxus" : `myoxus-${buildType}`;
if (isDev) {
  protocol = "myoxus-dev";
}

function isPayloadObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(
  payload: Record<string, unknown>,
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseAuthenticationRequest(
  method: string | null,
  rawPayload: string | null,
  server: string | undefined,
): AuthenticationRequest | null {
  if (!rawPayload) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload);
  } catch {
    return null;
  }
  if (!isPayloadObject(payload)) return null;

  if (method === "magic-link") {
    const email = requiredString(payload, "email");
    const token = requiredString(payload, "token");
    return email && token
      ? { method, payload: { email, token }, server }
      : null;
  }
  if (method === "oauth") {
    const code = requiredString(payload, "code");
    const state = requiredString(payload, "state");
    const provider = requiredString(payload, "provider");
    return code && state && provider
      ? { method, payload: { code, state, provider }, server }
      : null;
  }
  if (method === "open-app-signin") {
    const code = requiredString(payload, "code");
    return code ? { method, payload: { code }, server } : null;
  }
  return null;
}

export function setupDeepLink(app: App) {
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(protocol, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    }
  } else {
    app.setAsDefaultProtocolClient(protocol);
  }

  app.on("open-url", (event, url) => {
    logger.debug("received protocol URL", {
      matched: url.startsWith(`${protocol}://`),
    });
    if (url.startsWith(`${protocol}://`)) {
      event.preventDefault();
      app
        .whenReady()
        .then(() => handleMyoxusUrl(url))
        .catch((e) => {
          logger.error("failed to handle myoxus url", e);
        });
    }
  });

  // on windows & linux, we need to listen for the second-instance event
  app.on("second-instance", (event, commandLine) => {
    showMainWindow()
      .then(() => {
        const url = commandLine.pop();
        if (url?.startsWith(`${protocol}://`)) {
          event.preventDefault();
          handleMyoxusUrl(url).catch((e) => {
            logger.error("failed to handle myoxus url", e);
          });
        }
      })
      .catch((e) => console.error("Failed to restore or create window:", e));
  });

  app.on("ready", () => {
    // app may be brought up without having a running instance
    // need to read the url from the command line
    const url = process.argv.at(-1);
    logger.debug("protocol URL detected in startup arguments", {
      matched: Boolean(url?.startsWith(`${protocol}://`)),
    });
    if (url?.startsWith(`${protocol}://`)) {
      handleMyoxusUrl(url).catch((e) => {
        logger.error("failed to handle myoxus url", e);
      });
    }
  });
}

async function handleMyoxusUrl(url: string) {
  await showMainWindow();

  const urlObj = new URL(url);
  logger.info("open Myoxus protocol URL", { hostname: urlObj.hostname });

  if (urlObj.hostname === "authentication") {
    const method = urlObj.searchParams.get("method");
    const server = urlObj.searchParams.get("server") || undefined;
    const request = parseAuthenticationRequest(
      method,
      urlObj.searchParams.get("payload"),
      server,
    );

    if (!request) {
      logger.error("Invalid authentication protocol URL", { method });
      return;
    }
    uiSubjects.authenticationRequest$.next(request);
  } else if (
    urlObj.searchParams.get("new-tab") &&
    urlObj.pathname.startsWith("/workspace")
  ) {
    // @todo(@forehalo): refactor router utilities
    // basename of /workspace/xxx/yyy is /workspace/xxx
    await addTabWithUrl(url);
  } else {
    const hiddenWindow = urlObj.searchParams.get("hidden")
      ? await openUrlInHiddenWindow(urlObj)
      : await loadUrlInActiveTab(url);

    const main = await getMainWindow();
    if (main && hiddenWindow) {
      // when hidden window closed, the main window will be hidden somehow
      hiddenWindow.on("close", () => {
        main.show();
      });
    }
  }
}
