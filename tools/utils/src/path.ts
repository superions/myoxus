import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Convert an `import.meta.url`-like string to a filesystem path.
 *
 * Under Node's native ESM loader the URL is always `file://...`, but Vitest's
 * vite-node transport / browser pool may pass `http://localhost:.../path.ts`.
 * In that case we treat the URL pathname as the absolute filesystem path —
 * vite-node mirrors the actual disk path 1:1 in the URL.
 */
function metaUrlToFsPath(url: string): string {
  if (url.startsWith("file:") || url.startsWith("data:")) {
    return fileURLToPath(url);
  }
  // http:, https:, or any other vite-node-style URL: use the pathname
  // (which is the absolute filesystem path) as-is.
  return new URL(url).pathname;
}

export class Path {
  static dir(url: string) {
    return new Path(metaUrlToFsPath(url)).join("..");
  }

  get value() {
    return this.path;
  }

  get relativePath() {
    return "./" + this.path.slice(ProjectRoot.path.length).replace(/\\/g, "/");
  }

  constructor(private readonly path: string) {}

  join(...paths: string[]) {
    return new Path(join(this.path, ...paths));
  }

  parent() {
    return this.join("..");
  }

  toPosixString() {
    if (sep === "\\") {
      return this.path.replaceAll("\\", "/");
    }

    return this.path;
  }

  toString() {
    return this.path;
  }

  exists() {
    return existsSync(this.path);
  }

  rm(opts: { recursive?: boolean } = {}) {
    rmSync(this.path, { ...opts, force: true });
  }

  mkdir() {
    mkdirSync(this.path, { recursive: true });
  }

  readAsFile() {
    return readFileSync(this.path);
  }

  writeFile(content: Buffer | string) {
    writeFileSync(this.path, content);
  }

  stats() {
    return statSync(this.path);
  }

  isFile() {
    return this.exists() && this.stats().isFile();
  }

  isDirectory() {
    return this.exists() && this.stats().isDirectory();
  }

  toFileUrl() {
    return pathToFileURL(this.path);
  }

  relative(to: string) {
    const re = relative(this.value, to);
    if (sep === "\\") {
      return re.replaceAll("\\", "/");
    }

    return re;
  }
}

export const ProjectRoot = Path.dir(import.meta.url).join("../../../");
