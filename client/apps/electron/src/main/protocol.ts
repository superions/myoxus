import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path, { join } from "node:path";
import { pathToFileURL } from "node:url";

import { app, net, protocol, session } from "electron";

import { isWindows, resourcesPath } from "../shared/utils";
import { isDev } from "./config";
import { anotherHost, mainHost } from "./constants";
import { logger } from "./logger";
import {
  desktopSocketServer,
  desktopServerSession,
  persistDesktopServerCookies,
  proxyDesktopServerRequest,
  resolveDesktopServerRequest,
} from "./server-routing";

const webStaticDir = join(resourcesPath, "web-static");
const bundledFontsDir = join(webStaticDir, "api", "fonts");
const devServerBase = process.env.DEV_SERVER_URL;
const localWhiteListDirs = [
  path.resolve(app.getPath("sessionData")),
  path.resolve(app.getPath("temp")),
];

function isWithin(root: string, filepath: string) {
  const relative = path.relative(root, filepath);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Check lexical and canonical boundaries; Electron's fs also resolves ASAR paths. */
export function isFileWithinRoot(root: string, filepath: string) {
  if (!isWithin(path.resolve(root), path.resolve(filepath))) return false;
  try {
    return isWithin(realpathSync(root), realpathSync(filepath));
  } catch {
    return false;
  }
}

function buildTargetUrl(base: string, urlObject: URL) {
  return new URL(`${urlObject.pathname}${urlObject.search}`, base).toString();
}

function proxyRequest(
  request: Request,
  urlObject: URL,
  base: string,
  options: { bypassCustomProtocolHandlers?: boolean } = {},
) {
  const { bypassCustomProtocolHandlers = true } = options;
  const targetUrl = buildTargetUrl(base, urlObject);
  const proxiedRequest = bypassCustomProtocolHandlers
    ? Object.assign(request.clone(), {
        bypassCustomProtocolHandlers: true,
      })
    : request;
  return net.fetch(targetUrl, proxiedRequest);
}

export function resolveBundledFontPath(
  requestUrl: string,
  fontsDir: string = bundledFontsDir,
) {
  const urlObject = new URL(requestUrl);
  if (urlObject.host !== "." || !urlObject.pathname.startsWith("/api/fonts/")) {
    return null;
  }

  let fileName: string;
  try {
    fileName = decodeURIComponent(
      urlObject.pathname.slice("/api/fonts/".length),
    );
  } catch {
    return null;
  }
  if (
    !fileName ||
    fileName.includes("/") ||
    fileName.includes("\\") ||
    fileName !== path.basename(fileName)
  ) {
    return null;
  }

  const resolved = join(fontsDir, fileName).normalize();
  const root = fontsDir.endsWith(path.sep)
    ? fontsDir
    : `${fontsDir}${path.sep}`;
  return resolved.startsWith(root) ? resolved : null;
}

export async function handleFileRequest(request: Request) {
  const urlObject = new URL(request.url);

  if (urlObject.host === anotherHost) {
    urlObject.host = mainHost;
  }

  const isAbsolutePath = urlObject.host !== ".";
  const serverRequest =
    !isAbsolutePath && urlObject.pathname.startsWith("/_server/")
      ? resolveDesktopServerRequest(urlObject.toString())
      : null;
  // Server theme faces keep their registered-server identity, but canonical
  // packaged font bytes must also work offline (including standalone SVGs).
  // Validate registration first and never substitute a different version.
  const fontUrl = serverRequest
    ? new URL(
        serverRequest.target.pathname + serverRequest.target.search,
        "assets://.",
      )
    : urlObject;
  const bundledFontPath = resolveBundledFontPath(fontUrl.toString());
  if (bundledFontPath) {
    const present =
      existsSync(bundledFontPath) &&
      isFileWithinRoot(bundledFontsDir, bundledFontPath);
    const version = fontUrl.searchParams.get("v");
    const matches =
      present &&
      (!serverRequest ||
        !version ||
        (/^[\da-f]{8,64}$/i.test(version) &&
          createHash("sha256")
            .update(readFileSync(bundledFontPath))
            .digest("hex")
            .startsWith(version.toLowerCase())));
    if (matches) {
      const clonedRequest = Object.assign(request.clone(), {
        bypassCustomProtocolHandlers: true,
      });
      return net.fetch(
        pathToFileURL(bundledFontPath).toString(),
        clonedRequest,
      );
    }
    if (!serverRequest) return new Response("font not found", { status: 404 });
  }
  if (serverRequest)
    return proxyDesktopServerRequest(new Request(urlObject, request));

  const isApiRequest =
    !isAbsolutePath &&
    (urlObject.pathname.startsWith("/api/") ||
      urlObject.pathname === "/graphql");

  if (isApiRequest) {
    return new Response("Server ID required", { status: 403 });
  }

  const isFontRequest =
    urlObject.pathname &&
    /\.(woff2?|ttf|otf)$/i.test(urlObject.pathname.split("?")[0] ?? "");

  // Redirect to webpack dev server if available
  if (isDev && devServerBase && !isAbsolutePath && !isFontRequest) {
    return proxyRequest(request, urlObject, devServerBase, {
      bypassCustomProtocolHandlers: false,
    });
  }
  const clonedRequest = Object.assign(request.clone(), {
    bypassCustomProtocolHandlers: true,
  });
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(urlObject.pathname);
    if (decodedPath.includes("\0")) throw new Error("Invalid path");
  } catch {
    return new Response("Invalid path", { status: 400 });
  }
  let filepath: string;
  if (!isAbsolutePath) {
    // Validate the requested path even when extensionless routes use the SPA.
    const requested = join(webStaticDir, decodedPath);
    if (!isWithin(webStaticDir, requested)) {
      return new Response("File access denied", { status: 403 });
    }
    filepath = decodedPath.split("/").at(-1)?.includes(".")
      ? requested
      : join(webStaticDir, "index.html");
    if (!isFileWithinRoot(webStaticDir, filepath)) {
      return new Response("File unavailable", { status: 404 });
    }
  } else {
    filepath = isWindows()
      ? path.resolve(decodedPath.replace(/^\//, ""))
      : decodedPath;
    if (
      urlObject.host !== "local-file" ||
      !localWhiteListDirs.some((root) => isFileWithinRoot(root, filepath))
    ) {
      return new Response("File access denied", { status: 403 });
    }
  }
  return net.fetch(pathToFileURL(filepath).toString(), clonedRequest);
}

const needRefererDomains = [
  /^(?:[a-zA-Z0-9-]+\.)*youtube\.com$/,
  /^(?:[a-zA-Z0-9-]+\.)*youtube-nocookie\.com$/,
  /^(?:[a-zA-Z0-9-]+\.)*googlevideo\.com$/,
];
const defaultReferer = "https://client.myoxus.local/";

function setHeader(
  headers: Record<string, string[]>,
  name: string,
  value: string,
) {
  Object.keys(headers).forEach((key) => {
    if (key.toLowerCase() === name.toLowerCase()) {
      delete headers[key];
    }
  });
  headers[name] = [value];
}

/**
 * Build the Content-Security-Policy value for the app renderer.
 *
 * Directives chosen:
 *  - script-src 'self' 'wasm-unsafe-eval': WASM modules (e.g. yrs, crypto) need wasm-unsafe-eval;
 *    no eval permitted.
 *  - style-src 'self' 'unsafe-inline': Emotion/CSS-in-JS generates inline styles at runtime; no
 *    nonce-based CSP is feasible without SSR. This is a known limitation of CSS-in-JS.
 *  - connect-src 'self' https: http: wss: ws:: API endpoints follow registered user configuration
 *    (local / cloud / self-hosted). HTTP remains necessary for explicitly configured local and
 *    private-network servers; it is not enabled for any executable or embedded content directive.
 *    The navigation-allowlist in security-restrictions.ts and the preload API boundary provide the
 *    actual origin enforcement layer.
 *  - img-src 'self' data: blob: https:: avatars, embedded images, blob uploads.
 *  - media-src 'self' blob:: attachment playback uses object URLs backed by the
 *    workspace blob store; network and data media remain disallowed.
 *  - font-src 'self' data:: bundled fonts loaded as data URIs or from /static/fonts/.
 *  - object-src 'none': no plugins.
 *  - frame-src 'none': no iframes (embed views use BrowserView, not iframes).
 *  - In dev mode: add devServerBase to script-src/connect-src/style-src for HMR.
 */
export function buildRendererCsp(): string {
  const base = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "connect-src 'self' https: http: wss: ws:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ];

  if (isDev && devServerBase) {
    const devUrl = new URL(devServerBase);
    const devOrigin = devUrl.origin;
    const devWs = devOrigin.replace(/^http/, "ws");
    return base
      .map((directive) => {
        if (directive.startsWith("script-src"))
          return `${directive} ${devOrigin}`;
        if (directive.startsWith("connect-src"))
          return `${directive} ${devOrigin} ${devWs}`;
        if (directive.startsWith("style-src"))
          return `${directive} ${devOrigin}`;
        return directive;
      })
      .join("; ");
  }

  return base.join("; ");
}

function ensureFrameAncestors(
  headers: Record<string, string[]>,
  directive: string,
) {
  const cspHeaderKey = Object.keys(headers).find(
    (key) => key.toLowerCase() === "content-security-policy",
  );
  if (!cspHeaderKey) {
    headers["Content-Security-Policy"] = [`frame-ancestors ${directive}`];
    return;
  }

  const values = headers[cspHeaderKey];
  headers[cspHeaderKey] = values.map((val) => {
    if (typeof val !== "string") return val as any;
    const directives = val
      .split(";")
      .map((v) => v.trim())
      .filter(Boolean)
      .filter((d) => !d.toLowerCase().startsWith("frame-ancestors"));
    directives.push(`frame-ancestors ${directive}`);
    return directives.join("; ");
  });
}

function allowCors(
  headers: Record<string, string[]>,
  origin: string = "assets://.",
) {
  // Only a registered server origin receives the desktop CORS projection.
  setHeader(headers, "Access-Control-Allow-Origin", origin);
  setHeader(headers, "Access-Control-Allow-Credentials", "true");
  setHeader(headers, "Access-Control-Allow-Methods", "GET, HEAD, PUT, OPTIONS");
  setHeader(
    headers,
    "Access-Control-Allow-Headers",
    "*, Authorization, Content-Type, Range",
  );
}

export function registerProtocol() {
  protocol.handle("assets", (request) => {
    return handleFileRequest(request);
  });

  session.defaultSession.webRequest.onHeadersReceived(
    (responseDetails, callback) => {
      const { responseHeaders, url } = responseDetails;
      (async () => {
        if (responseHeaders) {
          const originalCookie =
            responseHeaders["set-cookie"] || responseHeaders["Set-Cookie"];

          const server = desktopSocketServer(url);
          if (server && originalCookie) {
            await persistDesktopServerCookies(server, url, originalCookie);
            delete responseHeaders["set-cookie"];
            delete responseHeaders["Set-Cookie"];
          }

          const { protocol } = new URL(url);

          // Only native scoped transports receive a credentialed CORS override.
          if (protocol === "assets:") {
            delete responseHeaders["access-control-allow-origin"];
            delete responseHeaders["access-control-allow-headers"];
            delete responseHeaders["Access-Control-Allow-Origin"];
            delete responseHeaders["Access-Control-Allow-Headers"];
            setHeader(responseHeaders, "X-Frame-Options", "DENY");
            setHeader(
              responseHeaders,
              "Content-Security-Policy",
              buildRendererCsp(),
            );
            ensureFrameAncestors(responseHeaders, "'none'");
          } else if (
            (protocol === "http:" || protocol === "https:") &&
            server
          ) {
            allowCors(responseHeaders);
          }
        }
      })()
        .catch((err) => {
          logger.error("error handling headers received", err);
        })
        .finally(() => {
          callback({ responseHeaders });
        });
    },
  );

  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const url = new URL(details.url);

    (async () => {
      // Native partitions own registered-server cookies, including same-host
      // servers on different ports. Never merge the default session's cookies.
      if (
        url.protocol === "http:" ||
        url.protocol === "https:" ||
        url.protocol === "ws:" ||
        url.protocol === "wss:"
      ) {
        delete details.requestHeaders["cookie"];
        delete details.requestHeaders["Cookie"];
        const server = desktopSocketServer(details.url);
        const cookies = server
          ? await desktopServerSession(server).cookies.get({
              url: server.baseUrl + url.pathname,
            })
          : [];

        const cookieString = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        details.requestHeaders["Cookie"] = cookieString;
      }

      const hostname = url.hostname;
      const needReferer = needRefererDomains.some((regex) =>
        regex.test(hostname),
      );
      if (needReferer && !details.requestHeaders["Referer"]) {
        details.requestHeaders["Referer"] = defaultReferer;
      }
    })()
      .then(() => {
        callback({
          cancel: false,
          requestHeaders: details.requestHeaders,
        });
      })
      .catch(() => {
        // Unknown/removed socket identities must not reach the network.
        callback({ cancel: true });
      });
  });
}
