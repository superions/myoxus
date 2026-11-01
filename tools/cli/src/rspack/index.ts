import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { getBuildConfig } from "@myoxus-tools/utils/build-config";
import { Path, ProjectRoot } from "@myoxus-tools/utils/path";
import { Package } from "@myoxus-tools/utils/workspace";
import rspack, {
  type Configuration as RspackConfiguration,
} from "@rspack/core";
import type { sentryWebpackPlugin as SentryWebpackPluginFactory } from "@sentry/bundler-plugins/webpack";
import { compact, merge } from "lodash-es";

import { productionCacheGroups } from "../rspack-shared/cache-group.js";
import {
  type CreateHTMLPluginConfig,
  createHTMLPlugins,
  getBuildRevision,
} from "../rspack-shared/html-plugin.js";

const require = createRequire(import.meta.url);

const IN_CI = !!process.env.CI;
// Rspack performance budgets use raw bytes, not transfer size. The Web/Admin
// shells currently ship one large initial workspace/editor bundle plus many
// lazy generated assets, so keep the budget explicit and high enough to warn
// only on real regressions instead of every production build.
const HTML_TARGET_MAX_ASSET_SIZE = 12 * 1024 * 1024;
const HTML_TARGET_MAX_ENTRYPOINT_SIZE = 18 * 1024 * 1024;
const RSPACK_RRULE_COMPAT_ALIAS = "rrule$";
const SERVICE_WORKER_BUILD_ID_PLACEHOLDER = "__MYOXUS_BUILD_ID__";

function injectServiceWorkerBuildId(
  content: Buffer,
  buildConfig: BUILD_CONFIG_TYPE,
) {
  const source = content.toString("utf8");
  if (!source.includes(SERVICE_WORKER_BUILD_ID_PLACEHOLDER)) {
    throw new Error("Service worker build ID placeholder is missing");
  }
  const buildId = `${buildConfig.appVersion}-${getBuildRevision()}`;
  return source.replaceAll(SERVICE_WORKER_BUILD_ID_PLACEHOLDER, buildId);
}

function excludeTranspiledWorkspacePackages(resourcePath: string) {
  // Workspace packages can be resolved through node_modules symlinks in dev.
  // Keep third-party dependencies excluded while allowing active Virgultum
  // source packages to ship TS/TSX editor presets into the web bundle.
  return (
    /[\\/]node_modules[\\/]/.test(resourcePath) &&
    !/[\\/]node_modules[\\/]@virgultum[\\/]/.test(resourcePath)
  );
}

function isExpectedLargeGeneratedAsset(assetFilename: string) {
  return (
    assetFilename.endsWith(".map") ||
    assetFilename.endsWith(".wasm") ||
    /\.(?:gif|mp4|zip)$/.test(assetFilename) ||
    /(?:^|\/)npm-async-(?:mermaid|@myriaddreamin|@shikijs|pdfjs-dist|katex|three)[.-]/.test(
      assetFilename,
    )
  );
}

function isFileTypeNodeOnlyImportWarning(warning: {
  details?: string;
  file?: string;
  message: string;
  module?: { readableIdentifier?: () => string } | null;
  stack?: string;
}) {
  // file-type keeps its Node-only fs helpers behind a non-literal import so
  // browser bundlers do not resolve them. Buffer detection never calls that
  // branch, and this package/module match preserves every unrelated warning.
  const description = `${warning.message}\n${warning.details ?? ""}\n${warning.stack ?? ""}`;
  const origin = `${warning.module?.readableIdentifier?.() ?? ""}\n${warning.file ?? ""}\n${description}`;
  return (
    (warning.message === "CriticalDependenciesWarning" ||
      /request of a dependency is an expression/.test(description)) &&
    /[\\/]file-type[\\/]source[\\/]index[.]js/.test(origin)
  );
}

const hasSentryBuildEnvs = () =>
  !!(
    process.env.SENTRY_AUTH_TOKEN &&
    process.env.SENTRY_ORG &&
    process.env.SENTRY_PROJECT
  );

function getBrowserTargetDevtool(
  buildConfig: BUILD_CONFIG_TYPE,
): RspackConfiguration["devtool"] {
  if (buildConfig.debug) {
    return "cheap-module-source-map";
  }

  if (buildConfig.isWeb || buildConfig.isAdmin) {
    // Public static artifacts intentionally contain no source maps. When a
    // Sentry release is configured, hidden maps remain available to its build
    // plugin without leaving sourceMappingURL references in public bundles.
    return hasSentryBuildEnvs() ? "hidden-source-map" : false;
  }

  return "source-map";
}

function createSentryPlugin() {
  if (!hasSentryBuildEnvs()) {
    return null;
  }

  try {
    const { sentryWebpackPlugin } =
      require("@sentry/bundler-plugins/webpack") as {
        sentryWebpackPlugin: typeof SentryWebpackPluginFactory;
      };

    return sentryWebpackPlugin({
      org: process.env.SENTRY_ORG!,
      project: process.env.SENTRY_PROJECT!,
      authToken: process.env.SENTRY_AUTH_TOKEN!,
    });
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown load error";
    throw new Error(
      `Failed to load the Sentry bundler plugin while SENTRY_* envs are set: ${reason}`,
    );
  }
}

const availableChannels = ["beta", "stable", "internal"];
function getBuildConfigFromEnv(pkg: Package) {
  const channel = process.env.BUILD_TYPE ?? "stable";
  const dev = process.env.NODE_ENV === "development";
  if (!availableChannels.includes(channel)) {
    throw new Error(
      `BUILD_TYPE must be one of ${availableChannels.join(", ")}, received [${channel}]`,
    );
  }

  return getBuildConfig(pkg, {
    // @ts-expect-error checked
    channel,
    mode: dev ? "development" : "production",
  });
}

function getOutputPublicPath(buildConfig: BUILD_CONFIG_TYPE) {
  if (!buildConfig.debug) {
    return "/";
  }
  return (
    process.env.MYOXUS_RSPACK_DEV_PUBLIC_PATH ?? process.env.PUBLIC_PATH ?? "/"
  );
}

export function createHTMLTargetConfig(
  pkg: Package,
  entry: string | Record<string, string>,
  htmlConfig: Partial<CreateHTMLPluginConfig> = {},
  deps?: string[],
): RspackConfiguration {
  entry = typeof entry === "string" ? { index: entry } : entry;

  htmlConfig = merge(
    {},
    {
      filename: "index.html",
      additionalEntryForSelfhost: true,
      injectGlobalErrorHandler: true,
      emitAssetsManifest: true,
    },
    htmlConfig,
  );

  const buildConfig = getBuildConfigFromEnv(pkg);
  if (!buildConfig.isAdmin) {
    execFileSync(
      process.execPath,
      [
        ProjectRoot.join(
          "build/scripts/templates/generate-document-bundles.mjs",
        ).value,
      ],
      { stdio: "inherit" },
    );
  }
  const publicPath = getOutputPublicPath(buildConfig);
  const pdfjsManifest = createRequire(
    new Package("@myoxus/core").join("package.json").value,
  ).resolve("pdfjs-dist/package.json");
  const pdfjsVersion: string = require(pdfjsManifest).version;

  console.log(
    `Building [${pkg.name}] for [${buildConfig.appBuildType}] channel in [${buildConfig.debug ? "development" : "production"}] mode.`,
  );
  console.log(
    `Entry points: ${Object.entries(entry)
      .map(([name, path]) => `${name}: ${path}`)
      .join(", ")}`,
  );
  console.log(`Output path: ${pkg.distPath.value}`);
  console.log(`Config: ${JSON.stringify(buildConfig, null, 2)}`);

  const config: RspackConfiguration = {
    //#region basic bundler config
    name: entry["index"],
    dependencies: deps,
    context: ProjectRoot.value,
    experiments: {
      asyncWebAssembly: true,
    },
    entry,
    output: {
      environment: { module: true, dynamicImport: true },
      filename: buildConfig.debug
        ? "js/[name].js"
        : "js/[name].[contenthash:8].js",
      cssFilename: buildConfig.debug
        ? "[name].css"
        : "[name].[contenthash:8].css",
      cssChunkFilename: buildConfig.debug
        ? "[name].css"
        : "[name].[contenthash:8].css",
      assetModuleFilename: buildConfig.debug
        ? "[name].[contenthash:8][ext]"
        : "assets/[name].[contenthash:8][ext][query]",
      path: pkg.distPath.value,
      clean: false,
      globalObject: "globalThis",
      publicPath,
    },
    target: ["web", "es2022"],
    mode: buildConfig.debug ? "development" : "production",
    devtool: getBrowserTargetDevtool(buildConfig),
    resolve: {
      symlinks: true,
      extensionAlias: {
        ".js": [".js", ".tsx", ".ts"],
        ".mjs": [".mjs", ".mts"],
      },
      extensions: [".js", ".ts", ".tsx"],
      // Browser dependencies may probe AsyncLocalStorage behind runtime guards.
      // Keep that optional Node capability out of Web and Electron renderers.
      fallback: { async_hooks: false },
      alias: {
        yjs: ProjectRoot.join("node_modules", "yjs").value,
        lit: ProjectRoot.join("node_modules", "lit").value,
        [RSPACK_RRULE_COMPAT_ALIAS]: ProjectRoot.join(
          "tools",
          "cli",
          "src",
          "rspack-shared",
          "rrule-compat.mjs",
        ).value,
        "@preact/signals-core": ProjectRoot.join(
          "node_modules",
          "@preact",
          "signals-core",
        ).value,
      },
    },
    //#endregion

    //#region module config
    module: {
      parser: {
        javascript: {
          // Do not mock Node.js globals
          node: false,
          requireJs: false,
          import: true,
          // Treat as missing export as error
          strictExportPresence: true,
        },
      },
      //#region rules
      rules: [
        { test: /\.m?js?$/, resolve: { fullySpecified: false } },
        {
          test: /\.js$/,
          enforce: "pre",
          include: /@virgultum/,
          extractSourceMap: true,
        },
        {
          oneOf: [
            {
              test: /\.ts$/,
              exclude: excludeTranspiledWorkspacePackages,
              loader: "builtin:swc-loader",
              options: {
                // https://swc.rs/docs/configuring-swc/
                jsc: {
                  preserveAllComments: true,
                  parser: {
                    syntax: "typescript",
                    dynamicImport: true,
                    topLevelAwait: false,
                    tsx: false,
                    decorators: true,
                  },
                  target: "es2022",
                  externalHelpers: false,
                  transform: {
                    useDefineForClassFields: false,
                    decoratorVersion: "2022-03",
                  },
                },
                sourceMaps: true,
                inlineSourcesContent: true,
              },
            },
            {
              test: /\.tsx$/,
              exclude: excludeTranspiledWorkspacePackages,
              loader: "builtin:swc-loader",
              options: {
                // https://swc.rs/docs/configuring-swc/
                jsc: {
                  preserveAllComments: true,
                  parser: {
                    syntax: "typescript",
                    dynamicImport: true,
                    topLevelAwait: false,
                    tsx: true,
                    decorators: true,
                  },
                  target: "es2022",
                  externalHelpers: false,
                  transform: {
                    react: { runtime: "automatic" },
                    useDefineForClassFields: false,
                    decoratorVersion: "2022-03",
                  },
                },
                sourceMaps: true,
                inlineSourcesContent: true,
              },
            },
            {
              test: /\.(png|jpg|gif|svg|webp|mp4|zip)$/,
              type: "asset/resource",
            },
            { test: /\.(ttf|eot|woff|woff2)$/, type: "asset/resource" },
            { test: /\.txt$/, type: "asset/source" },
            { test: /\.inline\.svg$/, type: "asset/inline" },
            {
              test: /fonts\.css$/,
              include: /client[\\/]libs[\\/]theme[\\/]src[\\/]fonts\.css$/,
              // This generated catalog contains only server-owned `/api/fonts`
              // URLs. They must remain browser requests, unlike relative CSS
              // assets, which the following native rule resolves and emits.
              type: "css",
              parser: { url: false, resolveImport: true },
            },
            {
              test: /\.css$/,
              // `css` is Rspack's global stylesheet module type. URL handling
              // emits relative assets while root-relative server URLs such as
              // `/api/fonts/...` remain runtime-owned.
              type: "css",
              parser: { url: true, resolveImport: true },
            },
          ],
        },
      ],
      //#endregion
    },
    //#endregion

    //#region plugins
    plugins: compact([
      !IN_CI && new rspack.ProgressPlugin(),
      ...createHTMLPlugins(buildConfig, htmlConfig),
      new rspack.DefinePlugin({
        "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
        ...Object.entries(buildConfig).reduce(
          (def, [k, v]) => {
            def[`BUILD_CONFIG.${k}`] = JSON.stringify(v);
            return def;
          },
          {} as Record<string, string>,
        ),
      }),
      // PDF.js fetches these by filename at runtime, including from the
      // dedicated renderer Worker. Keep resources and JS on the same version.
      new rspack.CopyRspackPlugin({
        patterns: ["cmaps", "standard_fonts", "iccs", "wasm"].map(
          (directory) => ({
            from: path.join(path.dirname(pdfjsManifest), directory),
            to: `pdfjs/${pdfjsVersion}/${directory}`,
          }),
        ),
      }),
      !buildConfig.isAdmin &&
        new rspack.CopyRspackPlugin({
          patterns: compact([
            {
              // copy the shared public assets into dist
              from: new Package("@myoxus/core").join("public").value,
              globOptions: { ignore: ["**/sw.js"] },
            },
            {
              // A release-specific cache namespace prevents a new frontend
              // from reviving app-shell or worker assets from an older build.
              from: new Package("@myoxus/core").join("public/sw.js").value,
              to: "sw.js",
              transform: (content: Buffer) =>
                injectServiceWorkerBuildId(content, buildConfig),
            },
            buildConfig.isElectron && {
              // Desktop serves bundled Web assets from its app:// static root.
              // Keep the app/server brand fallback contract identical to Web.
              from: ProjectRoot.join("client/branding").value,
              to: "style",
            },
            buildConfig.isElectron && {
              from: ProjectRoot.join("assets/branding/myoxus_text.svg").value,
              to: "style/logo.svg",
            },
            buildConfig.isElectron && {
              from: ProjectRoot.join(
                "client/libs/icons/src/assets/platform/browser-favicon.svg",
              ).value,
              to: "style/product-mark.svg",
            },
          ]),
        }),
      createSentryPlugin(),
      // sourcemap url like # sourceMappingURL=76-6370cd185962bc89.js.map wont load in electron
      // this is because the default file:// protocol will be ignored by Chromium
      // so we need to replace the sourceMappingURL to assets:// protocol
      // for example:
      // replace # sourceMappingURL=76-6370cd185962bc89.js.map
      // to      # sourceMappingURL=assets://./{dir}/76-6370cd185962bc89.js.map
      buildConfig.isElectron &&
        new rspack.SourceMapDevToolPlugin({
          append: (pathData: { filename?: string }) => {
            return `\n//# sourceMappingURL=assets://./${pathData.filename ?? ""}.map`;
          },
          filename: "[file].map",
        }),
    ]),
    //#endregion

    stats: { errorDetails: true },
    performance: buildConfig.debug
      ? { hints: false }
      : {
          hints: "warning",
          maxAssetSize: HTML_TARGET_MAX_ASSET_SIZE,
          maxEntrypointSize: HTML_TARGET_MAX_ENTRYPOINT_SIZE,
          assetFilter: (assetFilename) =>
            !isExpectedLargeGeneratedAsset(assetFilename),
        },

    //#region optimization
    optimization: {
      minimize: !buildConfig.debug,
      minimizer: [
        new rspack.SwcJsMinimizerRspackPlugin({
          extractComments: true,
          minimizerOptions: {
            ecma: 2020,
            compress: { unused: true },
            mangle: { keep_classnames: true },
          },
        }),
        new rspack.LightningCssMinimizerRspackPlugin(),
      ],
      removeEmptyChunks: true,
      providedExports: true,
      usedExports: true,
      sideEffects: true,
      runtimeChunk: { name: "runtime" },
      splitChunks: {
        chunks: "all",
        minSize: 1,
        minChunks: 1,
        maxInitialRequests: Number.MAX_SAFE_INTEGER,
        maxAsyncRequests: Number.MAX_SAFE_INTEGER,
        cacheGroups: {
          ...productionCacheGroups,
          // Rspack tends to pull async node_modules into the initial vendor chunk
          // when `vendor` is configured as `chunks: 'all'`.
          vendor: {
            ...productionCacheGroups.vendor,
            chunks: "initial",
          },
        },
      },
    },
    //#endregion
    ignoreWarnings: [isFileTypeNodeOnlyImportWarning],
  };

  if (buildConfig.debug && !IN_CI) {
    config.optimization = {
      ...config.optimization,
      minimize: false,
      runtimeChunk: false,
      splitChunks: {
        maxInitialRequests: Infinity,
        chunks: "all",
        cacheGroups: {
          defaultVendors: {
            test: `[\\/]node_modules[\\/]`,
            priority: -10,
            reuseExistingChunk: true,
          },
          default: { minChunks: 2, priority: -20, reuseExistingChunk: true },
          styles: {
            name: "styles",
            type: "css",
            chunks: "all",
            enforce: true,
          },
        },
      },
    };
  }

  return config;
}

export function createWorkerTargetConfig(
  pkg: Package,
  entry: string,
): Omit<RspackConfiguration, "name"> & { name: string } {
  const workerName = path.basename(entry).replace(/\.worker\.ts$/, "");
  const supportsAsyncChunks = workerName === "storage";
  const buildConfig = getBuildConfigFromEnv(pkg);
  const publicPath = getOutputPublicPath(buildConfig);

  return {
    name: entry,
    context: ProjectRoot.value,
    experiments: {
      asyncWebAssembly: true,
    },
    entry: { [workerName]: entry },
    output: {
      filename: `js/${workerName}-${buildConfig.appVersion}.worker.js`,
      ...(supportsAsyncChunks
        ? {
            chunkFilename: `js/${workerName}-[name].[contenthash:8].worker-chunk.js`,
          }
        : {}),
      path: pkg.distPath.value,
      clean: false,
      globalObject: "globalThis",
      publicPath,
    },
    target: ["webworker", "es2022"],
    mode: buildConfig.debug ? "development" : "production",
    devtool: getBrowserTargetDevtool(buildConfig),
    resolve: {
      symlinks: true,
      extensionAlias: { ".js": [".js", ".ts"], ".mjs": [".mjs", ".mts"] },
      extensions: [".js", ".ts"],
      alias: { yjs: ProjectRoot.join("node_modules", "yjs").value },
    },

    module: {
      parser: {
        javascript: {
          // Do not mock Node.js globals
          node: false,
          requireJs: false,
          import: true,
          // Treat as missing export as error
          strictExportPresence: true,
        },
      },
      rules: [
        { test: /\.m?js?$/, resolve: { fullySpecified: false } },
        {
          test: /\.js$/,
          enforce: "pre",
          include: /@virgultum/,
          extractSourceMap: true,
        },
        {
          oneOf: [
            {
              test: /\.ts$/,
              exclude: /node_modules/,
              loader: "builtin:swc-loader",
              options: {
                // https://swc.rs/docs/configuring-swc/
                jsc: {
                  preserveAllComments: true,
                  parser: {
                    syntax: "typescript",
                    dynamicImport: true,
                    topLevelAwait: false,
                    tsx: false,
                    decorators: true,
                  },
                  target: "es2022",
                  externalHelpers: false,
                  transform: {
                    useDefineForClassFields: false,
                    decoratorVersion: "2022-03",
                  },
                },
                sourceMaps: true,
                inlineSourcesContent: true,
              },
            },
            {
              test: /\.css$/,
              loader: Path.dir(import.meta.url).join(
                "../rspack-shared/empty-style-loader.js",
              ).value,
            },
          ],
        },
      ],
    },
    plugins: compact([
      new rspack.DefinePlugin(
        Object.entries(buildConfig).reduce(
          (def, [k, v]) => {
            def[`BUILD_CONFIG.${k}`] = JSON.stringify(v);
            return def;
          },
          {} as Record<string, string>,
        ),
      ),
      new rspack.optimize.LimitChunkCountPlugin({
        maxChunks: supportsAsyncChunks ? 2 : 1,
      }),
      createSentryPlugin(),
    ]),
    stats: { errorDetails: true },
    optimization: {
      minimize: !buildConfig.debug,
      minimizer: [
        new rspack.SwcJsMinimizerRspackPlugin({
          extractComments: true,
          minimizerOptions: {
            ecma: 2020,
            compress: { unused: true },
            mangle: { keep_classnames: true },
          },
        }),
      ],
      removeEmptyChunks: true,
      providedExports: true,
      usedExports: true,
      sideEffects: true,
      runtimeChunk: false,
      splitChunks: false,
    },
    performance: { hints: false },
    ignoreWarnings: [isFileTypeNodeOnlyImportWarning],
  };
}

export function createNodeTargetConfig(
  pkg: Package,
  entry: string,
  options: {
    outputFilename?: string;
    decoratorVersion?: "legacy" | "2022-03";
    libraryType?: "module" | "commonjs2";
    bundleAllDependencies?: boolean;
    forceExternal?: string[];
  } = {},
): Omit<RspackConfiguration, "name"> & { name: string } {
  const dev = process.env.NODE_ENV === "development";
  const useLegacyDecorator = options.decoratorVersion !== "2022-03";
  const forceExternal = options.forceExternal ?? [];
  return {
    name: entry,
    context: ProjectRoot.value,
    experiments: {
      asyncWebAssembly: true,
    },
    entry: { index: entry },
    output: {
      filename: options.outputFilename ?? "main.js",
      path: pkg.distPath.value,
      clean: true,
      globalObject: "globalThis",
      ...(options.libraryType
        ? { library: { type: options.libraryType } }
        : {}),
    },
    target: ["node", "es2022"],
    externals: ((data: any, callback: (err: null, value: boolean) => void) => {
      if (
        data.request &&
        forceExternal.some(
          (dep) => data.request === dep || data.request.startsWith(`${dep}/`),
        )
      ) {
        callback(null, true);
      } else if (
        data.request &&
        // import ... from 'module'
        /^[a-zA-Z@]/.test(data.request) &&
        !options.bundleAllDependencies &&
        // not workspace deps
        !pkg.deps.some((dep) => data.request!.startsWith(dep.name))
      ) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    }) as any,
    externalsPresets: { node: true },
    node: { __dirname: false, __filename: false },
    mode: dev ? "development" : "production",
    devtool: "source-map",
    resolve: {
      symlinks: true,
      extensionAlias: { ".js": [".js", ".ts"], ".mjs": [".mjs", ".mts"] },
      extensions: [".js", ".ts", ".tsx", ".node"],
      alias: { yjs: ProjectRoot.join("node_modules", "yjs").value },
    },
    module: {
      parser: {
        javascript: { url: false, importMeta: false, createRequire: false },
      },
      rules: [
        {
          test: /\.js$/,
          enforce: "pre",
          include: /@virgultum/,
          extractSourceMap: true,
        },
        {
          test: /\.node$/,
          loader: Path.dir(import.meta.url).join(
            "../rspack-shared/node-loader.js",
          ).value,
        },
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          loader: "builtin:swc-loader",
          options: {
            // https://swc.rs/docs/configuring-swc/
            jsc: {
              preserveAllComments: true,
              parser: {
                syntax: "typescript",
                dynamicImport: true,
                topLevelAwait: true,
                tsx: true,
                decorators: true,
              },
              target: "es2022",
              externalHelpers: false,
              transform: {
                ...(useLegacyDecorator
                  ? {
                      legacyDecorator: true,
                      decoratorMetadata: true,
                    }
                  : {
                      useDefineForClassFields: false,
                      decoratorVersion: "2022-03",
                    }),
                react: { runtime: "automatic" },
              },
            },
            sourceMaps: true,
            inlineSourcesContent: true,
          },
        },
      ],
    },
    plugins: compact([
      new rspack.optimize.LimitChunkCountPlugin({ maxChunks: 1 }),
      new rspack.IgnorePlugin({
        checkResource(resource) {
          const lazyImports = [
            "@nestjs/microservices",
            "@nestjs/websockets/socket-module",
            "@apollo/subgraph",
            "@apollo/gateway",
            "@as-integrations/fastify",
            "ts-morph",
            "class-validator",
            "class-transformer",
          ];
          return lazyImports.some((lazyImport) =>
            resource.startsWith(lazyImport),
          );
        },
      }),
      new rspack.DefinePlugin({
        "process.env.NODE_ENV": '"production"',
      }),
    ]),
    stats: { errorDetails: true },
    optimization: {
      nodeEnv: false,
      minimize: !dev,
      minimizer: [
        new rspack.SwcJsMinimizerRspackPlugin({
          extractComments: true,
          minimizerOptions: {
            ecma: 2020,
            compress: { unused: true },
            mangle: { keep_classnames: true },
          },
        }),
      ],
    },
    performance: { hints: false },
    ignoreWarnings: [
      isFileTypeNodeOnlyImportWarning,
      /^(?!CriticalDependenciesWarning$)/,
    ],
  };
}
