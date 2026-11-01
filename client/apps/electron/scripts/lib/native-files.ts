// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function writeFileAtomically(
  filePath: string,
  content: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const prepared = `${filePath}.tmp-${randomUUID()}`;
  try {
    await writeFile(prepared, content);
    await rename(prepared, filePath);
  } finally {
    await rm(prepared, { force: true });
  }
}

export async function moveFileAtomically(
  source: string,
  target: string,
): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const prepared = `${target}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, prepared);
    await rename(prepared, target);
    await rm(source);
  } finally {
    await rm(prepared, { force: true });
  }
}
