// SPDX-License-Identifier: AGPL-3.0-or-later

import { createBuildContext } from "../lib/build-context";
import { buildLinuxPackage } from "../lib/linux-native-packager";
import {
  assertPackagingTarget,
  loadPackagingIdentity,
} from "../lib/packaging-config";
import {
  ensurePackagedApplication,
  packageWithNativeTools,
} from "../lib/packaging-runner";

const context = createBuildContext();
assertPackagingTarget(context);
if (context.platform !== "linux")
  throw new Error("Linux packaging requires --platform linux");
const identity = await loadPackagingIdentity(context);
const targets = (process.env.LINUX_TARGETS ?? "deb,rpm,flatpak")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
if (
  !targets.length ||
  new Set(targets).size !== targets.length ||
  targets.some((target) => !["deb", "rpm", "flatpak"].includes(target))
)
  throw new Error(
    "Linux targets must be a unique nonempty subset of deb,rpm,flatpak",
  );
await ensurePackagedApplication(context);
const artifacts: string[] = [];
for (const value of targets) {
  const target = value as "deb" | "rpm" | "flatpak";
  artifacts.push(
    ...(await packageWithNativeTools({
      artifactExtensions: [target],
      context,
      packageType: target === "flatpak" ? undefined : target,
      target,
      build: (input) =>
        buildLinuxPackage({ ...input, context, identity, target }),
    })),
  );
}
process.stdout.write(`${artifacts.join("\n")}\n`);
