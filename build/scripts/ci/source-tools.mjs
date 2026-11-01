// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const runtime = process.env.MYOXUS_CI_SOURCE_TOOLS;
const requireTool = createRequire(
  runtime ? resolve(runtime, "package.json") : import.meta.url,
);

export function loadSourceTool(name) {
  return requireTool(name);
}

// CI installs this small runtime once on the host, never in a PR job. Refuse
// stale tools rather than silently linting with versions different from Yarn.
export function verifySourceTools(
  root = process.cwd(),
  names = ["oxlint", "eslint-plugin-react-hooks", "@swc/core", "yaml"],
) {
  if (!runtime) return;
  const { parse } = loadSourceTool("yaml");
  const lock = parse(readFileSync(resolve(root, "yarn.lock"), "utf8"));
  const manifest = JSON.parse(
    readFileSync(resolve(root, "package.json"), "utf8"),
  );
  for (const name of names) {
    const version = JSON.parse(
      readFileSync(
        resolve(runtime, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version;
    const range =
      manifest.devDependencies?.[name] ?? manifest.dependencies?.[name];
    const entry = Object.entries(lock).find(([descriptors]) =>
      descriptors.split(", ").includes(`${name}@npm:${range}`),
    )?.[1];
    if (entry?.resolution !== `${name}@npm:${version}`) {
      throw new Error(
        `CI source runtime ${name}@${version} does not match yarn.lock; provision the runtime outside CI`,
      );
    }
  }
}

export function sourceToolPath(path) {
  if (!runtime)
    throw new Error(
      "MYOXUS_CI_SOURCE_TOOLS is required for preinstalled CI tools",
    );
  return requireTool.resolve(path);
}
