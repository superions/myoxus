// SPDX-License-Identifier: AGPL-3.0-or-later

import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BuildContext } from "./build-context";
import { moveFileAtomically, pathExists } from "./native-files";
import { replaceDirectoryAtomically } from "./package-layout";
import { runProcess, yarnInvocation } from "./process";

type PackagingEvent = {
  artifactPath?: string;
  exitCode?: number;
  phase: "native-package" | "electron-packager";
  status: "complete" | "failed" | "start";
  target: string;
};

export function writePackagingEvent(event: PackagingEvent): void {
  process.stdout.write(
    `${JSON.stringify({ scope: "electron-packaging", ...event })}\n`,
  );
}

const forbiddenArtifactPattern =
  /^(?:RELEASES(?:\.json)?|Update\.exe)$|(?:squirrel|\.nupkg$)/i;

export function assertPublishableArtifactNames(paths: string[]): void {
  const forbidden = paths
    .map((candidate) => path.basename(candidate))
    .filter((name) => forbiddenArtifactPattern.test(name));
  if (forbidden.length > 0) {
    throw new Error(
      `Forbidden Electron packaging artifacts: ${forbidden.join(", ")}`,
    );
  }
}

export async function publishArtifactSet({
  artifactNames,
  generatedPaths,
  targetOutput,
}: {
  artifactNames?: string[];
  generatedPaths: string[];
  targetOutput: string;
}): Promise<string[]> {
  if (generatedPaths.length === 0) {
    throw new Error("Packager produced no artifacts");
  }
  const names =
    artifactNames ?? generatedPaths.map((entry) => path.basename(entry));
  if (
    names.length !== generatedPaths.length ||
    names.some(
      (name) => !name || name === "." || path.basename(name) !== name,
    ) ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length
  ) {
    throw new Error("Packaging artifact names must be one basename per output");
  }
  assertPublishableArtifactNames(names);

  const preparedOutput = `${targetOutput}.prepared-${process.pid}`;
  await rm(preparedOutput, { recursive: true, force: true });
  try {
    await mkdir(preparedOutput, { recursive: true });
    for (const [index, generatedPath] of generatedPaths.entries()) {
      await moveFileAtomically(
        generatedPath,
        path.join(preparedOutput, names[index]),
      );
    }
    await replaceDirectoryAtomically(preparedOutput, targetOutput);
  } finally {
    await rm(preparedOutput, { recursive: true, force: true });
  }
  return names.map((name) => path.join(targetOutput, name));
}

export async function ensurePackagedApplication(
  context: BuildContext,
  skipPackage = process.env.SKIP_PACKAGE === "1",
): Promise<void> {
  if (!skipPackage) {
    const yarn = yarnInvocation(context.repoRoot, [
      "workspace",
      "@myoxus/electron",
      "package",
      "--platform",
      context.platform,
      "--arch",
      context.arch,
    ]);
    await runProcess({ ...yarn, cwd: context.repoRoot });
  }
  if (!(await pathExists(context.packagedAppDir))) {
    throw new Error(
      `Packaged Electron app not found at ${context.packagedAppDir}`,
    );
  }
}

/** Clone the sealed application, build one complete set, then publish atomically.
 * Native builders must return only artifacts inside their temporary output tree.
 */
export async function packageWithNativeTools({
  artifactExtensions,
  build,
  context,
  packageType,
  target,
}: {
  artifactExtensions: readonly string[];
  build: (input: {
    application: string;
    outputDirectory: string;
  }) => Promise<string[]>;
  context: BuildContext;
  packageType?: "deb" | "nsis" | "rpm";
  target: string;
}): Promise<string[]> {
  await ensurePackagedApplication(context, true);

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), `myoxus-${target}-`));
  const temporaryApp = path.join(temporaryRoot, "app");
  const temporaryOutput = path.join(temporaryRoot, "output");
  const targetOutput = path.join(context.makeDir, target);
  writePackagingEvent({ phase: "native-package", status: "start", target });
  try {
    // Framework links must remain relative when the packaged app is relocated.
    await cp(context.packagedAppDir, temporaryApp, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await mkdir(temporaryOutput, { recursive: true });
    if (packageType) {
      await writeFile(
        path.join(temporaryApp, "resources", "package-type"),
        `${packageType}\n`,
      );
    }
    const application =
      context.platform === "darwin"
        ? path.join(temporaryApp, `${context.productName}.app`)
        : temporaryApp;

    const generated = await build({
      application,
      outputDirectory: temporaryOutput,
    });
    assertPublishableArtifactNames(generated);
    if (
      generated.some(
        (file) =>
          !path.resolve(file).startsWith(`${temporaryOutput}${path.sep}`),
      )
    ) {
      throw new Error(
        "Native packager returned an artifact outside its output tree",
      );
    }
    for (const file of generated) {
      const info = await lstat(file);
      if (!info.isFile() || info.size === 0)
        throw new Error("Native packager must return nonempty regular files");
    }
    let publishable = generated;
    if (artifactExtensions) {
      const expected = new Set(
        artifactExtensions.map((extension) => extension.toLowerCase()),
      );
      publishable = generated.filter((generatedPath) =>
        expected.has(path.extname(generatedPath).slice(1).toLowerCase()),
      );
      const unexpected = generated.filter(
        (generatedPath) => !publishable.includes(generatedPath),
      );
      const counts = new Map<string, number>();
      for (const generatedPath of publishable) {
        const extension = path.extname(generatedPath).slice(1).toLowerCase();
        counts.set(extension, (counts.get(extension) ?? 0) + 1);
      }
      if (
        unexpected.length > 0 ||
        [...expected].some((extension) => counts.get(extension) !== 1)
      ) {
        throw new Error(
          `Native packager artifact set differs: ${generated.map((entry) => path.basename(entry)).join(", ")}`,
        );
      }
    }
    const artifacts = await publishArtifactSet({
      generatedPaths: publishable,
      targetOutput,
    });
    for (const artifactPath of artifacts) {
      writePackagingEvent({
        artifactPath,
        exitCode: 0,
        phase: "native-package",
        status: "complete",
        target,
      });
    }
    return artifacts;
  } catch (error) {
    writePackagingEvent({
      exitCode: 1,
      phase: "native-package",
      status: "failed",
      target,
    });
    throw error;
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
