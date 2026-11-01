import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import rspack, { type Configuration } from "@rspack/core";
import { sentryWebpackPlugin } from "@sentry/bundler-plugins/webpack";
import { afterEach, describe, expect, test, vi } from "vitest";

const fixtureDirectories: string[] = [];
const originalSentryTempDirectory = process.env.SENTRY_TEST_OVERRIDE_TEMP_DIR;

afterEach(() => {
  if (originalSentryTempDirectory === undefined) {
    delete process.env.SENTRY_TEST_OVERRIDE_TEMP_DIR;
  } else {
    process.env.SENTRY_TEST_OVERRIDE_TEMP_DIR = originalSentryTempDirectory;
  }
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture() {
  // macOS temporary paths may be symlinks; Rspack resolves module paths.
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), "myoxus-sentry-rspack-")),
  );
  const outputPath = join(directory, "dist");
  fixtureDirectories.push(directory);
  writeFileSync(
    join(directory, "entry.js"),
    "export const releaseMarker = 'myoxus-sentry-rspack';\n",
  );
  return { directory, outputPath };
}

function compile(config: Configuration) {
  const compiler = rspack(config);
  return new Promise<void>((resolve, reject) => {
    compiler.run((error, stats) => {
      const finish = (result?: Error) => {
        compiler.close((closeError) => {
          if (result || closeError) {
            reject(result ?? closeError);
          } else {
            resolve();
          }
        });
      };
      if (error) {
        finish(error);
      } else if (!stats || stats.hasErrors()) {
        finish(new Error(stats?.toString("errors-only") ?? "Missing stats"));
      } else {
        finish();
      }
    });
  });
}

function createConfig(
  directory: string,
  outputPath: string,
  plugin: NonNullable<Configuration["plugins"]>[number],
): Configuration {
  return {
    context: directory,
    mode: "production",
    entry: "./entry.js",
    devtool: "hidden-source-map",
    output: { path: outputPath, filename: "bundle.js", clean: true },
    optimization: { minimize: false },
    plugins: [plugin],
  };
}

describe("Rspack Sentry integration", () => {
  test("emits a debug ID and private matching map without uploading", async () => {
    const { directory, outputPath } = createFixture();
    const plugin = sentryWebpackPlugin({
      org: "controlled-fixture",
      project: "controlled-fixture",
      authToken: "controlled-fixture",
      telemetry: false,
      release: { inject: false, create: false },
      sourcemaps: { disable: "disable-upload" },
      silent: true,
    });

    await compile(createConfig(directory, outputPath, plugin));

    const bundle = readFileSync(join(outputPath, "bundle.js"), "utf8");
    const sourceMap = JSON.parse(
      readFileSync(join(outputPath, "bundle.js.map"), "utf8"),
    ) as { file?: string; sources?: string[]; sourcesContent?: string[] };
    expect(bundle).toMatch(/sentry-dbid-[0-9a-f-]{36}/);
    expect(bundle).not.toContain("sourceMappingURL");
    expect(sourceMap.file).toBe("bundle.js");
    expect(sourceMap.sources).toContain("webpack:///./entry.js");
    expect(sourceMap.sourcesContent).toContain(
      "export const releaseMarker = 'myoxus-sentry-rspack';\n",
    );
  });

  test("prepares matching debug IDs and reports a private upload failure", async () => {
    const { directory, outputPath } = createFixture();
    const uploadPath = join(directory, "controlled-upload");
    const uploadError = vi.fn();
    mkdirSync(uploadPath);
    process.env.SENTRY_TEST_OVERRIDE_TEMP_DIR = uploadPath;
    const plugin = sentryWebpackPlugin({
      org: "controlled-fixture",
      project: "controlled-fixture",
      authToken: "controlled-fixture",
      url: "http://127.0.0.1:1/",
      telemetry: false,
      release: { inject: false, create: false },
      sourcemaps: { assets: join(outputPath, "**/*.{js,map}") },
      errorHandler: uploadError,
      silent: true,
    });

    await compile(createConfig(directory, outputPath, plugin));

    expect(uploadError).toHaveBeenCalled();
    expect(
      uploadError.mock.calls.every(([error]) => error instanceof Error),
    ).toBe(true);
    const uploadFiles = readdirSync(uploadPath);
    const preparedBundle = uploadFiles.find((file) => file.endsWith(".js"));
    const preparedMap = uploadFiles.find((file) => file.endsWith(".js.map"));
    expect(preparedBundle).toBeDefined();
    expect(preparedMap).toBeDefined();
    const bundle = readFileSync(join(uploadPath, preparedBundle!), "utf8");
    const debugId = bundle.match(/\/\/# debugId=([0-9a-f-]{36})/)?.[1];
    const sourceMap = JSON.parse(
      readFileSync(join(uploadPath, preparedMap!), "utf8"),
    ) as { debug_id?: string; debugId?: string };
    expect(debugId).toBeDefined();
    expect(sourceMap.debug_id).toBe(debugId);
    expect(sourceMap.debugId).toBe(debugId);
  });
});
