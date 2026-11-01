import type { Configuration as RspackDevServerConfiguration } from "@rspack/dev-server";

export const RSPACK_SUPPORTED_PACKAGES = [
  "@myoxus/admin",
  "@myoxus/web",
  "@myoxus/mobile",
  "@myoxus/ios",
  "@myoxus/android",
  "@myoxus/electron-renderer",
  "@myoxus/server",
  "@myoxus/reader",
] as const;

const rspackSupportedPackageSet = new Set<string>(RSPACK_SUPPORTED_PACKAGES);

export function isRspackSupportedPackageName(name: string) {
  return rspackSupportedPackageSet.has(name);
}

export function assertRspackSupportedPackageName(name: string) {
  if (isRspackSupportedPackageName(name)) {
    return;
  }

  throw new Error(
    `Rspack bundling currently supports: ${Array.from(RSPACK_SUPPORTED_PACKAGES).join(", ")}. Unsupported package: ${name}.`,
  );
}

function parsePort(value: string | undefined, fallback: number) {
  if (!value) {
    return fallback;
  }
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`Invalid Rspack dev server port: ${value}`);
  }
  return port;
}

function normalizePathPrefix(value: string | undefined, fallback = "/") {
  if (!value) {
    return fallback;
  }
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash
    : `${withLeadingSlash}/`;
}

function createProxyConfig(target: string) {
  return [
    {
      context: "/api",
      target,
    },
    {
      context: "/socket.io",
      target,
      ws: true,
    },
    {
      context: "/graphql",
      target,
    },
    {
      context: "/info",
      target,
    },
    {
      context: "/style",
      target,
    },
  ];
}

export function createDevServerConfigFromEnv(
  overrides: RspackDevServerConfiguration = {},
): RspackDevServerConfiguration {
  const host = process.env.MYOXUS_RSPACK_DEV_HOST ?? "0.0.0.0";
  const port = parsePort(process.env.MYOXUS_RSPACK_DEV_PORT, 8080);
  const clientHost = process.env.MYOXUS_RSPACK_DEV_CLIENT_HOST ?? host;
  const clientPort = parsePort(process.env.MYOXUS_RSPACK_DEV_CLIENT_PORT, port);
  const wsProtocol = process.env.MYOXUS_RSPACK_DEV_WS_PROTOCOL ?? "ws";
  const proxyOrigin =
    process.env.MYOXUS_RSPACK_DEV_PROXY_ORIGIN ?? "http://localhost:3010";
  const publicPath = normalizePathPrefix(
    process.env.MYOXUS_RSPACK_DEV_PUBLIC_PATH ?? process.env.PUBLIC_PATH,
  );

  return {
    host,
    port,
    allowedHosts: "all",
    // Native Rspack CSS modules participate in the same HMR graph as their
    // importing JavaScript. A full-page live reload discards application state
    // and can leave a rapidly replaced stylesheet stale behind the dev gateway.
    hot: true,
    liveReload: false,
    compress: !process.env.CI,
    setupExitSignals: true,
    devMiddleware: {
      publicPath,
    },
    client: {
      overlay: process.env.DISABLE_DEV_OVERLAY === "true" ? false : undefined,
      logging: process.env.CI ? "none" : "error",
      // see: https://webpack.js.org/configuration/dev-server/#websocketurl
      // must be explicit because custom protocols and reverse proxies cannot
      // always derive a usable HMR/live-reload websocket endpoint.
      webSocketURL: `${wsProtocol}://${clientHost}:${clientPort}/ws`,
    },
    historyApiFallback: {
      rewrites: [
        {
          from: /.*/,
          to: () => {
            return process.env.SELF_HOSTED === "true"
              ? "/selfhost.html"
              : "/index.html";
          },
        },
      ],
    },
    proxy: createProxyConfig(proxyOrigin),
    ...overrides,
  };
}

export const DEFAULT_DEV_SERVER_CONFIG: RspackDevServerConfiguration = {
  ...createDevServerConfigFromEnv(),
};
