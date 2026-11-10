// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type ElectronNativeTarget,
  type ElectronTargetArch,
  type ElectronTargetLibc,
  type ElectronTargetPlatform,
  nativeTargetFromTriple,
  targetTripleFor,
} from "./lib/build-context";
import { yarnInvocation } from "./lib/process";

const require = createRequire(import.meta.url);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRootDir = path.join(__dirname, "..", "..", "..", "..");

type NativeTarget = Omit<ElectronNativeTarget, "triple"> & {
  triple?: string;
};

type NativeBinding = {
  name: string;
  workspace: string;
  candidates: string[];
  copyAdjacentToBundle?: boolean;
  verify?: (resolvedPath: string, target: NativeTarget) => void;
};

const buildMissing = process.argv.includes("--build-missing");
const copyToIndex = process.argv.indexOf("--copy-to");
const copyTargetDir =
  copyToIndex >= 0 && process.argv[copyToIndex + 1]
    ? path.resolve(process.argv[copyToIndex + 1])
    : undefined;

if (copyToIndex >= 0 && !copyTargetDir) {
  throw new Error("--copy-to requires a target directory");
}

function tripleForTarget(target: NativeTarget) {
  if (target.triple) {
    return target.triple;
  }
  return targetTripleFor(target.platform, target.arch, target.libc);
}

function resolveTarget(): NativeTarget {
  const explicitTarget = process.env.TARGET?.trim();
  if (explicitTarget) {
    const target = nativeTargetFromTriple(explicitTarget);
    if (target) return target;
  }

  const platform = process.env.MYOXUS_NATIVE_PLATFORM as
    ElectronTargetPlatform | undefined;
  const arch = process.env.MYOXUS_NATIVE_ARCH as ElectronTargetArch | undefined;
  if (platform && arch) {
    return {
      platform,
      arch,
      libc: process.env.MYOXUS_NATIVE_LIBC as ElectronTargetLibc | undefined,
      triple: explicitTarget || undefined,
    };
  }

  if (
    !["darwin", "linux", "win32"].includes(process.platform) ||
    !["arm64", "x64"].includes(process.arch)
  ) {
    throw new Error(
      `Unsupported native host target ${process.platform}/${process.arch}`,
    );
  }
  return {
    platform: process.platform as ElectronTargetPlatform,
    arch: process.arch as ElectronTargetArch,
    triple: explicitTarget || undefined,
  };
}

function localStoreCandidates(target: NativeTarget) {
  if (target.platform === "darwin") {
    return [
      "client/libs/local-store/myoxus_storage.darwin-universal.node",
      `client/libs/local-store/myoxus_storage.darwin-${target.arch}.node`,
    ];
  }

  if (target.platform === "win32") {
    return [
      `client/libs/local-store/myoxus_storage.win32-${target.arch}-msvc.node`,
    ];
  }

  if (target.platform === "linux") {
    const libc = target.libc ?? "gnu";
    return [
      `client/libs/local-store/myoxus_storage.linux-${target.arch}-${libc}.node`,
    ];
  }

  throw new Error(
    `Unsupported native binding target ${target.platform}/${target.arch}`,
  );
}

function isCurrentRuntimeTarget(target: NativeTarget) {
  return target.platform === process.platform && target.arch === process.arch;
}

function runWorkspaceBuild(workspace: string, target: NativeTarget): void {
  const buildEnv = {
    ...process.env,
    TARGET: tripleForTarget(target),
    CARGO_BUILD_TARGET: tripleForTarget(target),
  };
  // Packaging consumes the checked-in declarations, not a host-specific NAPI
  // regeneration. Keep build-only declarations outside the immutable sources.
  const declarations = path.join(
    repoRootDir,
    "target",
    "electron-native-types",
  );
  mkdirSync(declarations, { recursive: true });
  const yarn = yarnInvocation(repoRootDir, [
    "workspace",
    workspace,
    "build",
    "--dts",
    path.join(
      "..",
      "..",
      "..",
      "target",
      "electron-native-types",
      `${workspace.split("/").at(-1)}-${target.arch}.d.ts`,
    ),
  ]);
  const result = spawnSync(yarn.command, yarn.args, {
    cwd: repoRootDir,
    env: buildEnv,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${workspace} native build exited with code ${result.status ?? "null"} and signal ${result.signal ?? "none"}`,
    );
  }
}

function verifyMediaExports(resolvedPath: string, target: NativeTarget) {
  if (!isCurrentRuntimeTarget(target)) return;
  const native = require(resolvedPath);
  // An older Linux binary can load successfully but expose only the decoder.
  // Verify the capture entry point without opening an audio device: packaging
  // hosts need no audio session, but must not silently ship that stale binary.
  if (typeof native.ShareableContent !== "function") {
    throw new Error(
      "@myoxus/media-capture native binding is stale: missing ShareableContent. " +
        "Rebuild @myoxus/media-capture from the current source before packaging.",
    );
  }
}

function ensureBinding(binding: NativeBinding, target: NativeTarget): void {
  const resolveCandidate = () =>
    binding.candidates
      .map((candidate) => path.join(repoRootDir, candidate))
      .find((candidate) => {
        if (!existsSync(candidate)) return false;
        if (target.platform !== "darwin" || process.platform !== "darwin")
          return true;
        const result = spawnSync(
          "lipo",
          [
            candidate,
            "-verify_arch",
            target.arch === "x64" ? "x86_64" : "arm64",
          ],
          { encoding: "utf8" },
        );
        if (result.error) throw result.error;
        return result.status === 0;
      });

  let resolvedPath = resolveCandidate();
  if (!resolvedPath && buildMissing) {
    runWorkspaceBuild(binding.workspace, target);
    resolvedPath = resolveCandidate();
  }

  if (!resolvedPath) {
    throw new Error(
      `${binding.name} native binding is missing for ${target.platform}/${target.arch}. ` +
        `Run yarn workspace ${binding.workspace} build or yarn workspace @myoxus/electron native:ensure.`,
    );
  }

  binding.verify?.(resolvedPath, target);
  console.log(`${binding.name}: ${path.relative(repoRootDir, resolvedPath)}`);

  if (copyTargetDir && binding.copyAdjacentToBundle) {
    mkdirSync(copyTargetDir, { recursive: true });
    for (const entry of readdirSync(copyTargetDir)) {
      if (/^myoxus_storage\..+\.node$/.test(entry)) {
        rmSync(path.join(copyTargetDir, entry));
      }
    }
    const destination = path.join(copyTargetDir, path.basename(resolvedPath));
    copyFileSync(resolvedPath, destination);
    console.log(
      `${binding.name}: copied runtime binding to ${path.relative(repoRootDir, destination)}`,
    );
  }
}

const target = resolveTarget();
const bindings: NativeBinding[] = [
  {
    name: "@myoxus/crypto",
    workspace: "@myoxus/crypto",
    candidates: ["client/libs/crypto/myoxus_crypto.node"],
  },
  {
    name: "@myoxus/media-capture",
    workspace: "@myoxus/media-capture",
    candidates: ["client/libs/media-capture/myoxus_media.node"],
    verify: verifyMediaExports,
  },
  {
    name: "@myoxus/local-store",
    workspace: "@myoxus/local-store",
    candidates: localStoreCandidates(target),
    // The CommonJS native loader is bundled into helper.js and resolves its
    // platform binary relative to that bundle at runtime. Esbuild cannot see
    // those dynamic requires, so the Electron layer build must materialize the
    // selected binary alongside helper.js explicitly. Loading this binding in
    // the short-lived packaging process would start its async NAPI runtime;
    // Electron's owning Vitest/runtime gates verify the exported API instead.
    copyAdjacentToBundle: true,
  },
];

console.log(
  `Ensuring Electron native bindings for ${target.platform}/${target.arch}`,
);

for (const binding of bindings) {
  ensureBinding(binding, target);
}
