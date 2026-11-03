// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readZip } from "../zip-archive.mjs";

export async function verifyRetiredTemplateAssets(repoRoot) {
  const forbiddenPaths = [
    "client/libs/templates",
    "virgultum/editor/gfx/template/src/toolbar/cards.ts",
    "client/libs/core/public/static/templates",
    "client/libs/core/src/editor/ai/components/ai-chat-messages/templates",
    "client/libs/core/src/editor/ai/components/ai-chat-messages/preload-config.ts",
    "client/libs/core/src/editor/virgultum/doc-editor/register-templates.ts",
    "client/libs/core/src/desktop/dialogs/setting/general-setting/meetings/meeting-apps.light.assets.svg",
    "client/libs/core/src/desktop/dialogs/setting/general-setting/meetings/meeting-apps.dark.assets.svg",
  ];
  const failures = forbiddenPaths.filter((path) =>
    existsSync(join(repoRoot, path)),
  );
  const fingerprints = new Set(
    JSON.parse(
      readFileSync(
        join(repoRoot, "build/asset-policy/retired-templates.json"),
        "utf8",
      ),
    ).sha256,
  );
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const check = (name, bytes) => {
    if (fingerprints.has(digest(bytes))) failures.push(name);
  };
  // Include untracked source assets, but not ignored build caches or user data.
  const files = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "client",
      "virgultum",
    ],
    { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  for (const file of new Set(files)) {
    if (
      !/\.(json|svg|png|jpe?g|webp|zip|tsx?|mjs)$/i.test(file) ||
      !existsSync(join(repoRoot, file))
    )
      continue;
    const bytes = readFileSync(join(repoRoot, file));
    check(file, bytes);
    if (
      !/\.zip$/i.test(file) ||
      bytes.length < 4 ||
      bytes.readUInt16LE(0) !== 0x4b50
    )
      continue;
    const archive = await readZip(bytes, { maxBytes: 64 * 1024 * 1024 });
    for (const [name, entry] of archive) {
      if (!entry.directory) check(`${file}#${name}`, entry.data);
    }
  }
  if (failures.length)
    throw new Error(
      `Retired template assets must not return:\n${failures.join("\n")}`,
    );
}
