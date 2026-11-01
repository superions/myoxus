#!/usr/bin/env node
import { createReadStream, statSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import net from "node:net";
import { extname, join, normalize, relative, resolve } from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const host = process.env.MYOXUS_DEV_GATEWAY_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MYOXUS_DEV_GATEWAY_PORT ?? "3011", 10);
const webOrigin = new URL(
  process.env.MYOXUS_DEV_WEB_ORIGIN ?? "http://127.0.0.1:3012",
);
const adminOrigin = new URL(
  process.env.MYOXUS_DEV_ADMIN_ORIGIN ?? "http://127.0.0.1:3013",
);
const backendOrigin = new URL(
  process.env.MYOXUS_DEV_BACKEND_ORIGIN ?? "http://127.0.0.1:3010",
);
// Isolated QA must resolve uploaded assets from the same server as AdminRoot.
// Omission retains the local static mode used by source-only frontend work.
const assetOrigin = process.env.MYOXUS_DEV_ASSET_ORIGIN
  ? new URL(process.env.MYOXUS_DEV_ASSET_ORIGIN)
  : null;
const styleRoot = resolve(
  process.env.MYOXUS_DEV_STYLE_ROOT ?? join(repoRoot, "client/branding"),
);
const canonicalStyleAssets = new Map([
  ["/style/logo.svg", join(repoRoot, "assets/branding/myoxus_text.svg")],
  [
    "/style/product-mark.svg",
    join(repoRoot, "client/libs/icons/src/assets/platform/browser-favicon.svg"),
  ],
]);
const fontRoot = resolve(
  process.env.MYOXUS_DEV_FONT_ROOT ?? join(repoRoot, "server/static/fonts"),
);

const backendExactPaths = new Map([
  ["/api", "/api/"],
  ["/graphql", "/graphql"],
  ["/info", "/info"],
  ["/ready", "/ready"],
  ["/socket.io", "/socket.io"],
]);
// Match Nginx: anonymous publishing belongs to the API, ahead of the Web SPA.
const backendPrefixes = ["/api/", "/socket.io/", "/public/", "/public-assets/"];
const adminBackendPrefixes = [
  ["/adminfrontend/api/", "/api/"],
  ["/adminfrontend/socket.io/", "/socket.io/"],
];
const adminBackendExact = new Map([
  ["/adminfrontend/api", "/api/"],
  ["/adminfrontend/graphql", "/graphql"],
  ["/adminfrontend/info", "/info"],
  ["/adminfrontend/ready", "/ready"],
  ["/adminfrontend/socket.io", "/socket.io"],
]);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
]);

function assertPort(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > 65_535) {
    throw new Error(`${name} must be a valid TCP port, received ${value}`);
  }
}

assertPort(port, "MYOXUS_DEV_GATEWAY_PORT");

function requestPath(req) {
  return new URL(req.url ?? "/", "http://dev-gateway.local").pathname;
}

function rewriteAdminBackendPath(path) {
  const exact = adminBackendExact.get(path);
  if (exact) {
    return exact;
  }
  for (const [prefix, replacement] of adminBackendPrefixes) {
    if (path.startsWith(prefix)) {
      return `${replacement}${path.slice(prefix.length)}`;
    }
  }
  return null;
}

function backendPathFor(path) {
  const adminPath = rewriteAdminBackendPath(path);
  if (adminPath) {
    return adminPath;
  }
  const exact = backendExactPaths.get(path);
  if (exact) {
    return exact;
  }
  if (backendPrefixes.some((prefix) => path.startsWith(prefix))) {
    return path;
  }
  return null;
}

function isAdminHtmlNavigation(req, path) {
  if (!(req.method === "GET" || req.method === "HEAD")) {
    return false;
  }
  if (!path.startsWith("/adminfrontend")) {
    return false;
  }
  const accept = String(req.headers.accept ?? "");
  return accept.includes("text/html") || extname(path) === "";
}

function stylePathFor(path) {
  if (path.startsWith("/adminfrontend/style/")) {
    return `/style/${path.slice("/adminfrontend/style/".length)}`;
  }
  if (path.startsWith("/style/")) {
    return path;
  }
  return null;
}

function fontPathFor(path) {
  if (path.startsWith("/adminfrontend/api/fonts/")) {
    return `/api/fonts/${path.slice("/adminfrontend/api/fonts/".length)}`;
  }
  if (path.startsWith("/api/fonts/")) {
    return path;
  }
  return null;
}

function sendStaticFromRoot(req, res, root, routePath, routePrefix) {
  let decoded;
  try {
    decoded = decodeURIComponent(routePath.slice(routePrefix.length));
  } catch {
    res.writeHead(400).end("bad static path");
    return;
  }

  const candidate = normalize(join(root, decoded));
  if (relative(root, candidate).startsWith("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }

  let stat;
  try {
    stat = statSync(candidate);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404).end("not found");
    return;
  }

  const type =
    contentTypes.get(extname(candidate)) ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": stat.size,
  });
  createReadStream(candidate).pipe(res);
}

function sendStaticFile(req, res, filePath) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  if (!stat.isFile()) {
    res.writeHead(404).end("not found");
    return;
  }

  const type =
    contentTypes.get(extname(filePath)) ?? "application/octet-stream";
  res.writeHead(200, {
    "content-type": type,
    "cache-control": "no-store",
    "content-length": stat.size,
  });
  createReadStream(filePath).pipe(res);
}

function sendStyle(req, res, stylePath) {
  const canonicalAsset = canonicalStyleAssets.get(stylePath);
  if (canonicalAsset) {
    sendStaticFile(req, res, canonicalAsset);
    return;
  }
  sendStaticFromRoot(req, res, styleRoot, stylePath, "/style/");
}

function sendFont(req, res, fontPath) {
  sendStaticFromRoot(req, res, fontRoot, fontPath, "/api/fonts/");
}

function proxyHttp(req, res, targetOrigin, pathOverride = null) {
  const incoming = new URL(req.url ?? "/", "http://dev-gateway.local");
  const target = new URL(
    pathOverride ?? `${incoming.pathname}${incoming.search}`,
    targetOrigin,
  );
  if (pathOverride && incoming.search && !target.search) {
    target.search = incoming.search;
  }

  const headers = { ...req.headers };
  headers.host = target.host;
  headers["x-forwarded-host"] = req.headers.host ?? `${host}:${port}`;
  headers["x-forwarded-proto"] = "http";

  const client = target.protocol === "https:" ? httpsRequest : httpRequest;
  let proxyReq;
  // Closing a browser SSE response must also stop the upstream generation.
  // IncomingMessage's normal request-body close is not a client disconnect.
  res.once("close", () => {
    if (!res.writableFinished) proxyReq.destroy();
  });
  const closeOnPipeError = (stream, error) => {
    if (
      error?.code !== "ECONNRESET" &&
      error?.code !== "ERR_STREAM_PREMATURE_CLOSE"
    ) {
      console.warn(`[dev-gateway] proxy stream error: ${error.message}`);
    }
    stream.destroy();
  };
  proxyReq = client(
    target,
    {
      method: req.method,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.on("error", (error) => closeOnPipeError(res, error));
      res.on("error", (error) => closeOnPipeError(proxyRes, error));
      proxyRes.pipe(res);
    },
  );

  proxyReq.on("error", (error) => {
    if (error.code === "ECONNRESET" && res.destroyed) {
      return;
    }
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    }
    res.end(`dev gateway proxy error: ${error.message}`);
  });
  req.on("error", (error) => closeOnPipeError(proxyReq, error));
  req.pipe(proxyReq);
}

function proxyUpgrade(req, socket, head, targetOrigin, pathOverride = null) {
  const incoming = new URL(req.url ?? "/", "http://dev-gateway.local");
  const target = new URL(
    pathOverride ?? `${incoming.pathname}${incoming.search}`,
    targetOrigin,
  );
  if (pathOverride && incoming.search && !target.search) {
    target.search = incoming.search;
  }

  const targetPort = Number.parseInt(
    target.port || (target.protocol === "https:" ? "443" : "80"),
    10,
  );
  const connect = target.protocol === "https:" ? tls.connect : net.connect;
  const upstream = connect(targetPort, target.hostname, () => {
    const headerLines = [
      `${req.method} ${target.pathname}${target.search} HTTP/${req.httpVersion}`,
    ];
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.toLowerCase() === "host") {
        headerLines.push(`host: ${target.host}`);
      } else if (Array.isArray(value)) {
        for (const item of value) headerLines.push(`${name}: ${item}`);
      } else if (typeof value === "string") {
        headerLines.push(`${name}: ${value}`);
      }
    }
    upstream.write(`${headerLines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) {
      upstream.write(head);
    }
    upstream.pipe(socket).pipe(upstream);
  });

  // Browser contexts routinely reset upgraded sockets during navigation. Both
  // halves need handlers so a client-side ECONNRESET cannot terminate the dev
  // gateway while long-running visual matrices rotate pages or contexts.
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  upstream.on("close", () => socket.destroy());
  socket.on("close", () => upstream.destroy());
}

const server = createServer((req, res) => {
  const path = requestPath(req);

  if (path === "/health") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end("ok\n");
    return;
  }

  const stylePath = stylePathFor(path);
  if (stylePath) {
    if (assetOrigin) proxyHttp(req, res, assetOrigin, stylePath);
    else sendStyle(req, res, stylePath);
    return;
  }

  const fontPath = fontPathFor(path);
  if (fontPath) {
    if (assetOrigin) proxyHttp(req, res, assetOrigin, fontPath);
    else sendFont(req, res, fontPath);
    return;
  }

  if (assetOrigin && /^\/favicon(?:-\d+)?\.(?:png|svg)$/.test(path)) {
    proxyHttp(req, res, assetOrigin);
    return;
  }

  const backendPath = backendPathFor(path);
  if (backendPath) {
    proxyHttp(req, res, backendOrigin, backendPath);
    return;
  }

  if (path === "/admin" || path.startsWith("/admin/")) {
    const replacement =
      path === "/admin"
        ? "/adminfrontend/"
        : `/adminfrontend/${path.slice("/admin/".length)}`;
    res.writeHead(308, { location: replacement });
    res.end();
    return;
  }

  if (path.startsWith("/adminfrontend")) {
    proxyHttp(
      req,
      res,
      adminOrigin,
      isAdminHtmlNavigation(req, path) ? "/adminfrontend/" : null,
    );
    return;
  }

  proxyHttp(req, res, webOrigin);
});

server.on("upgrade", (req, socket, head) => {
  const path = requestPath(req);
  const backendPath = backendPathFor(path);
  if (backendPath) {
    proxyUpgrade(req, socket, head, backendOrigin, backendPath);
    return;
  }
  if (path.startsWith("/adminfrontend")) {
    proxyUpgrade(req, socket, head, adminOrigin);
    return;
  }
  proxyUpgrade(req, socket, head, webOrigin);
});

server.listen(port, host, () => {
  console.log(`[dev-gateway] listening on http://${host}:${port}`);
  console.log(`[dev-gateway] web -> ${webOrigin.href}`);
  console.log(`[dev-gateway] admin -> ${adminOrigin.href}`);
  console.log(`[dev-gateway] backend -> ${backendOrigin.href}`);
  console.log(`[dev-gateway] style -> ${assetOrigin?.href ?? styleRoot}`);
  console.log(`[dev-gateway] fonts -> ${assetOrigin?.href ?? fontRoot}`);
});
