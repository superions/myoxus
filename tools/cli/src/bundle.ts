import { rmSync } from "node:fs";
import { cpus } from "node:os";

import { Logger } from "@myoxus-tools/utils/logger";
import { Package } from "@myoxus-tools/utils/workspace";
import rspack, { type MultiRspackOptions } from "@rspack/core";
import { type Configuration as RspackDevServerConfiguration } from "@rspack/dev-server";
import { merge } from "lodash-es";

import {
  assertRspackSupportedPackageName,
  createDevServerConfigFromEnv,
} from "./bundle-shared";
import { Option, PackageCommand } from "./command";
import { FrontendDevServer } from "./frontend-dev-server";
import {
  createHTMLTargetConfig as createRspackHTMLTargetConfig,
  createNodeTargetConfig as createRspackNodeTargetConfig,
  createWorkerTargetConfig as createRspackWorkerTargetConfig,
} from "./rspack";
import {
  shouldUploadReleaseAssets,
  uploadDistAssetsToS3,
} from "./rspack-shared/s3-plugin.js";

type WorkerConfig = { name: string };
type CreateWorkerTargetConfig = (pkg: Package, entry: string) => WorkerConfig;

function assertRspackSupportedPackage(pkg: Package) {
  assertRspackSupportedPackageName(pkg.name);
}

function shouldUploadAssetsForPackage(pkg: Package): boolean {
  return (
    !!process.env.R2_SECRET_ACCESS_KEY && shouldUploadReleaseAssets(pkg.name)
  );
}

async function uploadAssetsForPackage(pkg: Package, logger: Logger) {
  if (!shouldUploadAssetsForPackage(pkg)) {
    return;
  }
  logger.info("Uploading dist assets to R2...");
  await uploadDistAssetsToS3(pkg.distPath.value);
  logger.info("Uploaded dist assets to R2.");
}

function getBaseWorkerConfigs(
  pkg: Package,
  createWorkerTargetConfig: CreateWorkerTargetConfig,
) {
  const core = new Package("@myoxus/core");

  return [
    createWorkerTargetConfig(
      pkg,
      core.srcPath.join(
        "modules/workspace-engine/impls/workspace-profile.worker.ts",
      ).value,
    ),
    createWorkerTargetConfig(
      pkg,
      core.srcPath.join("modules/pdf/renderer/pdf.worker.ts").value,
    ),
    createWorkerTargetConfig(
      pkg,
      core.srcPath.join(
        "editor/view-extensions/turbo-renderer/turbo-painter.worker.ts",
      ).value,
    ),
  ];
}

function getRspackBundleConfigs(pkg: Package): MultiRspackOptions {
  assertRspackSupportedPackage(pkg);

  switch (pkg.name) {
    case "@myoxus/admin": {
      return [
        createRspackHTMLTargetConfig(pkg, pkg.srcPath.join("index.tsx").value, {
          selfhostPublicPath: "/admin/",
        }),
      ] as MultiRspackOptions;
    }
    case "@myoxus/web":
    case "@myoxus/mobile":
    case "@myoxus/ios":
    case "@myoxus/android": {
      const workerConfigs = getBaseWorkerConfigs(
        pkg,
        createRspackWorkerTargetConfig,
      );
      workerConfigs.push(
        createRspackWorkerTargetConfig(
          pkg,
          pkg.srcPath.join("storage.worker.ts").value,
        ),
      );

      return [
        createRspackHTMLTargetConfig(
          pkg,
          pkg.srcPath.join("index.tsx").value,
          {},
          workerConfigs.map((config) => config.name),
        ),
        ...workerConfigs,
      ] as MultiRspackOptions;
    }
    case "@myoxus/electron-renderer": {
      const workerConfigs = getBaseWorkerConfigs(
        pkg,
        createRspackWorkerTargetConfig,
      );

      return [
        createRspackHTMLTargetConfig(
          pkg,
          {
            index: pkg.srcPath.join("app/index.tsx").value,
            shell: pkg.srcPath.join("shell/index.tsx").value,
            popup: pkg.srcPath.join("popup/index.tsx").value,
            backgroundWorker: pkg.srcPath.join("background-worker/index.ts")
              .value,
          },
          {
            additionalEntryForSelfhost: false,
            injectGlobalErrorHandler: false,
            emitAssetsManifest: false,
          },
          workerConfigs.map((config) => config.name),
        ),
        ...workerConfigs,
      ] as MultiRspackOptions;
    }
    // @myoxus/server removed — Rust server replaces NestJS
    case "@myoxus/reader": {
      return [
        createRspackNodeTargetConfig(pkg, pkg.srcPath.join("index.ts").value, {
          outputFilename: "index.js",
          decoratorVersion: "2022-03",
          libraryType: "module",
          bundleAllDependencies: true,
          forceExternal: ["yjs"],
        }),
      ] as MultiRspackOptions;
    }
  }

  throw new Error(`Unsupported package: ${pkg.name}`);
}

export class BundleCommand extends PackageCommand {
  static override paths = [["bundle"], ["pack"], ["bun"]];

  // bundle is not able to run with deps
  override _deps = false;
  override waitDeps = false;

  dev = Option.Boolean("--dev,-d", false, {
    description: "Run in Development mode",
  });

  devServerHost = Option.String("--dev-server-host", {
    description: "Rspack dev server host in --dev mode",
  });

  devServerPort = Option.String("--dev-server-port", {
    description: "Rspack dev server port in --dev mode",
  });

  devServerProxyOrigin = Option.String("--dev-server-proxy-origin", {
    description: "Backend/proxy origin for Rspack dev server API routes",
  });

  devServerPublicPath = Option.String("--dev-server-public-path", {
    description: "Dev-only public path for emitted Rspack assets",
  });

  devServerClientHost = Option.String("--dev-server-client-host", {
    description: "Browser-visible host for the Rspack websocket client",
  });

  devServerClientPort = Option.String("--dev-server-client-port", {
    description: "Browser-visible port for the Rspack websocket client",
  });

  private applyDevServerOptionsToEnv() {
    if (this.devServerHost) {
      process.env.MYOXUS_RSPACK_DEV_HOST = this.devServerHost;
    }
    if (this.devServerPort) {
      process.env.MYOXUS_RSPACK_DEV_PORT = this.devServerPort;
    }
    if (this.devServerProxyOrigin) {
      process.env.MYOXUS_RSPACK_DEV_PROXY_ORIGIN = this.devServerProxyOrigin;
    }
    if (this.devServerPublicPath) {
      process.env.MYOXUS_RSPACK_DEV_PUBLIC_PATH = this.devServerPublicPath;
      process.env.PUBLIC_PATH = this.devServerPublicPath;
    }
    if (this.devServerClientHost) {
      process.env.MYOXUS_RSPACK_DEV_CLIENT_HOST = this.devServerClientHost;
    }
    if (this.devServerClientPort) {
      process.env.MYOXUS_RSPACK_DEV_CLIENT_PORT = this.devServerClientPort;
    }
  }

  async execute() {
    const pkg = this.workspace.getPackage(this.package);

    if (this.dev) {
      this.applyDevServerOptionsToEnv();
      await BundleCommand.dev(pkg);
    } else {
      await BundleCommand.build(pkg);
    }
  }

  static async build(pkg: Package) {
    return BundleCommand.buildWithRspack(pkg);
  }

  static async dev(
    pkg: Package,
    devServerConfig?: RspackDevServerConfiguration,
  ) {
    return BundleCommand.devWithRspack(pkg, devServerConfig);
  }

  static async buildWithRspack(pkg: Package) {
    process.env.NODE_ENV = "production";
    assertRspackSupportedPackage(pkg);

    const logger = new Logger("bundle");
    logger.info(`Packing package ${pkg.name} with rspack...`);
    logger.info("Cleaning old output...");
    rmSync(pkg.distPath.value, { recursive: true, force: true });

    const config = getRspackBundleConfigs(pkg);
    config.parallelism = cpus().length;

    const compiler = rspack(config);
    if (!compiler) {
      throw new Error("Failed to create rspack compiler");
    }

    try {
      const stats = await new Promise<any>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error) {
            reject(error);
            return;
          }
          if (!stats) {
            reject(new Error("Failed to get rspack stats"));
            return;
          }
          resolve(stats);
        });
      });
      if (stats.hasErrors()) {
        console.error(stats.toString("errors-only"));
        process.exit(1);
        return;
      }
      console.log(stats.toString("minimal"));
      await uploadAssetsForPackage(pkg, logger);
    } catch (error) {
      console.error(error);
      process.exit(1);
      return;
    }
  }

  static async devWithRspack(
    pkg: Package,
    devServerConfig?: RspackDevServerConfiguration,
  ) {
    process.env.NODE_ENV = "development";
    assertRspackSupportedPackage(pkg);

    const logger = new Logger("bundle");
    logger.info(`Starting rspack dev server for ${pkg.name}...`);

    const config = getRspackBundleConfigs(pkg);
    config.parallelism = cpus().length;

    const compiler = rspack(config);
    if (!compiler) {
      throw new Error("Failed to create rspack compiler");
    }

    const devServer = new FrontendDevServer(
      merge({}, createDevServerConfigFromEnv(), devServerConfig),
      compiler,
    );

    await devServer.start();
  }
}
