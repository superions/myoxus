import { resolve } from "node:path";

import { getBuildConfig } from "@myoxus-tools/utils/build-config";
import { Workspace } from "@myoxus-tools/utils/workspace";
import { sentryEsbuildPlugin } from "@sentry/bundler-plugins/esbuild";
import type { BuildOptions, Plugin } from "esbuild";

import type { BuildContext } from "./lib/build-context";

export const NODE_MAJOR_VERSION = 26;

const workspace = new Workspace();

export const config = (
  context: BuildContext,
  environment: NodeJS.ProcessEnv = process.env,
): BuildOptions => {
  const mode = environment.NODE_ENV ?? "development";
  const electronE2e = environment.ELECTRON_E2E === "1";
  const electronE2eUpdateFeed =
    environment.ELECTRON_E2E_UPDATE_FEED?.trim() || null;
  if (electronE2eUpdateFeed && !electronE2e) {
    throw new Error(
      "ELECTRON_E2E_UPDATE_FEED is only valid when ELECTRON_E2E=1",
    );
  }
  if (electronE2eUpdateFeed) {
    const url = new URL(electronE2eUpdateFeed);
    if (
      url.protocol !== "https:" ||
      url.pathname !== "/api/v1/repos/myoxus/packages/releases"
    ) {
      throw new Error(
        "ELECTRON_E2E_UPDATE_FEED must be an HTTPS Forgejo myoxus/packages releases endpoint",
      );
    }
  }
  const define = {
    "process.env.GITHUB_SHA": environment.GITHUB_SHA,
    "process.env.SENTRY_RELEASE": environment.SENTRY_RELEASE,
    "process.env.SENTRY_DSN": environment.SENTRY_DSN,
    "process.env.DEV_SERVER_URL": environment.DEV_SERVER_URL,
    "process.env.NODE_ENV": mode,
    REPLACE_ME_BUILD_ENV: context.buildType,
    REPLACE_ME_ELECTRON_E2E: electronE2e,
    REPLACE_ME_ELECTRON_E2E_UPDATE_FEED: electronE2eUpdateFeed,
    ...Object.entries(
      getBuildConfig(workspace.getPackage("@myoxus/electron"), {
        mode: mode === "production" ? "production" : "development",
        channel: context.buildType as any,
      }),
    ).reduce(
      (def, [key, val]) => {
        def[`BUILD_CONFIG.${key}`] = val;
        return def;
      },
      {} as Record<string, any>,
    ),
  };

  const plugins: Plugin[] = [];

  if (
    environment.SENTRY_AUTH_TOKEN &&
    environment.SENTRY_ORG &&
    environment.SENTRY_PROJECT
  ) {
    plugins.push(
      sentryEsbuildPlugin({
        org: environment.SENTRY_ORG,
        project: environment.SENTRY_PROJECT,
        authToken: environment.SENTRY_AUTH_TOKEN,
      }),
    );
  }

  plugins.push({
    name: "no-side-effects",
    setup(build) {
      build.onResolve({ filter: /\.js/ }, async (args) => {
        if (args.pluginData) return; // Ignore this if we called ourselves

        const { path, ...rest } = args;

        // mark all virgultum packages as side-effect free
        // because they will include a lot of files that are not used in node_modules
        if (rest.resolveDir.includes("virgultum")) {
          rest.pluginData = true; // Avoid infinite recursion
          const result = await build.resolve(path, rest);

          result.sideEffects = false;
          return result;
        }
        return null;
      });
    },
  });

  return {
    entryPoints: [
      resolve(
        context.electronDir,
        environment.ELECTRON_E2E === "1"
          ? "./src/main/e2e-entry.ts"
          : "./src/main/index.ts",
      ),
      resolve(context.electronDir, "./src/preload/index.ts"),
      resolve(context.electronDir, "./src/helper/index.ts"),
    ],
    entryNames: "[dir]",
    outdir: resolve(context.electronDir, "./dist"),
    bundle: true,
    target: `node${NODE_MAJOR_VERSION}`,
    platform: "node",
    // A packaged app has no runtime node_modules tree. Keep only Electron's
    // host API external; every JavaScript dependency must be in the bundle.
    external: ["electron"],
    format: "cjs",
    loader: {
      ".node": "copy",
    },
    define: Object.entries(define).reduce(
      (def, [key, val]) => {
        def[key] =
          JSON.stringify(val) ??
          String(
            val,
          ); /* JSON.stringify(undefined) == undefined, but we need 'undefined' */
        return def;
      },
      {} as Record<string, string>,
    ),
    assetNames: "[name]",
    treeShaking: true,
    // External maps remain available to Sentry but do not add a sourceMappingURL
    // to runtime bundles, so staging can exclude them without dangling links.
    sourcemap: "external",
    plugins,
  };
};
