// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  moveFileAtomically,
  pathExists,
  readJsonFile,
  writeFileAtomically,
} from "../../scripts/lib/native-files";

const tempDirs: string[] = [];

async function createTempDir() {
  const directory = await mkdtemp(path.join(tmpdir(), "myoxus-native-files-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("Electron native file operations", () => {
  test("creates parent directories and atomically replaces file contents", async () => {
    const directory = await createTempDir();
    const target = path.join(directory, "nested", "metadata.xml");

    await writeFileAtomically(target, "first");
    await writeFileAtomically(target, "second");

    await expect(readFile(target, "utf8")).resolves.toBe("second");
    await expect(pathExists(target)).resolves.toBe(true);
  });

  test("moves output into a missing directory and removes its source", async () => {
    const directory = await createTempDir();
    const source = path.join(directory, "artifact.tmp");
    const target = path.join(directory, "release", "artifact.exe");
    await writeFile(source, "installer");

    await moveFileAtomically(source, target);

    await expect(readFile(target, "utf8")).resolves.toBe("installer");
    await expect(pathExists(source)).resolves.toBe(false);
  });

  test("propagates malformed JSON and missing-source failures", async () => {
    const directory = await createTempDir();
    const malformed = path.join(directory, "package.json");
    await writeFile(malformed, '{"version":');

    await expect(readJsonFile(malformed)).rejects.toBeInstanceOf(SyntaxError);
    await expect(
      moveFileAtomically(
        path.join(directory, "missing"),
        path.join(directory, "release", "artifact.exe"),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const regularFile = path.join(directory, "regular-file");
    await writeFile(regularFile, "not a directory");
    await expect(
      pathExists(path.join(regularFile, "child")),
    ).rejects.toMatchObject({ code: "ENOTDIR" });
  });
});
