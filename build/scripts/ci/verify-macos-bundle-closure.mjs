#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function auditBundleLinks(app) {
  const root = await fs.realpath(app);
  const files = [];
  const problems = [];
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.readlink(candidate);
        if (path.isAbsolute(target)) {
          problems.push(
            `${path.relative(root, candidate)}: absolute symlink ${target}`,
          );
          continue;
        }
        if (!inside(root, path.resolve(directory, target))) {
          problems.push(
            `${path.relative(root, candidate)}: escaping symlink ${target}`,
          );
          continue;
        }
        try {
          if (!inside(root, await fs.realpath(candidate))) {
            problems.push(
              `${path.relative(root, candidate)}: symlink resolves outside app`,
            );
          }
        } catch (error) {
          if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) throw error;
          problems.push(
            `${path.relative(root, candidate)}: broken/cyclic symlink ${target}`,
          );
        }
      } else if (entry.isDirectory()) {
        await walk(candidate);
      } else if (entry.isFile()) {
        files.push(candidate);
      } else {
        problems.push(
          `${path.relative(root, candidate)}: unsupported filesystem entry`,
        );
      }
    }
  }
  await walk(root);
  if (problems.length)
    throw new Error(`Non-portable macOS bundle:\n${problems.join("\n")}`);
  return { root, files };
}

const dependencyCommands = new Set([
  "LC_LOAD_DYLIB",
  "LC_LOAD_WEAK_DYLIB",
  "LC_REEXPORT_DYLIB",
  "LC_LOAD_UPWARD_DYLIB",
  "LC_LAZY_LOAD_DYLIB",
]);

export function parseMachOLoadCommands(output) {
  const dependencies = [];
  const rpaths = [];
  let executable = false;
  for (const block of output.split(/^Load command \d+\s*$/m).slice(1)) {
    const command = block.match(/^\s*cmd (LC_\w+)\s*$/m)?.[1];
    if (command === "LC_MAIN" || command === "LC_UNIXTHREAD") executable = true;
    if (command !== "LC_RPATH" && !dependencyCommands.has(command)) continue;
    const field = command === "LC_RPATH" ? "path" : "name";
    const value = block.match(
      new RegExp(`^\\s*${field} (.+) \\(offset \\d+\\)\\s*$`, "m"),
    )?.[1];
    if (!value) throw new Error(`Cannot parse ${command} load command`);
    if (command === "LC_RPATH") rpaths.push(value);
    else dependencies.push(value);
  }
  if (!/^Load command \d+/m.test(output))
    throw new Error("No Mach-O load commands found");
  return { dependencies, rpaths, executable };
}

function systemLibrary(candidate) {
  if (!path.isAbsolute(candidate)) return false;
  const normalized = path.normalize(candidate);
  return (
    normalized.startsWith("/usr/lib/") ||
    normalized.startsWith("/System/Library/")
  );
}

// A library may inherit LC_RPATH from its loader chain. Native .node modules
// are dlopen roots, so also verify them against the actual executable contexts.
export async function verifyMachODependencies({
  root,
  images,
  mainExecutable,
}) {
  if (!images.has(mainExecutable))
    throw new Error(`Main executable missing/not Mach-O: ${mainExecutable}`);
  const entries = [...images].filter(
    ([file, metadata]) => file === mainExecutable || metadata.executable,
  );
  const covered = new Set();
  const contexts = [];

  function expand(value, loader, executableDirectory) {
    let candidate;
    if (value === "@loader_path" || value.startsWith("@loader_path/")) {
      candidate = path.resolve(
        path.dirname(loader),
        value.slice("@loader_path".length).replace(/^\//, ""),
      );
    } else if (
      value === "@executable_path" ||
      value.startsWith("@executable_path/")
    ) {
      candidate = path.resolve(
        executableDirectory,
        value.slice("@executable_path".length).replace(/^\//, ""),
      );
    } else if (path.isAbsolute(value) && systemLibrary(value)) {
      return value;
    } else {
      throw new Error(
        `External/unsupported dependency path ${value} in ${path.relative(root, loader)}`,
      );
    }
    if (!inside(root, candidate))
      throw new Error(
        `Dependency escapes app: ${value} in ${path.relative(root, loader)}`,
      );
    return candidate;
  }

  async function visitRoot(start, executableDirectory, inherited) {
    const seen = new Set();
    const discoveredContexts = [];
    async function visit(file, parentRpaths) {
      if (seen.has(file)) return;
      seen.add(file);
      const metadata = images.get(file);
      if (!metadata)
        throw new Error(`Dependency is not a verified Mach-O image: ${file}`);
      const rpaths = [
        ...new Set([
          ...metadata.rpaths.map((value) =>
            expand(value, file, executableDirectory),
          ),
          ...parentRpaths,
        ]),
      ];
      discoveredContexts.push({ executableDirectory, rpaths });
      for (const dependency of metadata.dependencies) {
        if (systemLibrary(dependency)) continue; // May exist only in the dyld shared cache.
        const candidates = dependency.startsWith("@rpath/")
          ? rpaths.map((base) =>
              path.resolve(base, dependency.slice("@rpath/".length)),
            )
          : [expand(dependency, file, executableDirectory)];
        let resolved;
        for (const candidate of candidates) {
          if (systemLibrary(candidate)) {
            resolved = "system";
            break;
          }
          if (!inside(root, candidate))
            throw new Error(`Dependency escapes app: ${dependency}`);
          try {
            const real = await fs.realpath(candidate);
            if (!inside(root, real))
              throw new Error(`Dependency resolves outside app: ${dependency}`);
            if (!images.has(real))
              throw new Error(`Dependency is not Mach-O: ${candidate}`);
            resolved = real;
            break;
          } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
          }
        }
        if (!resolved)
          throw new Error(
            `Unresolved dependency ${dependency} from ${path.relative(root, file)}; searched: ${candidates.join(", ") || "no LC_RPATH"}`,
          );
        if (resolved !== "system") await visit(resolved, rpaths);
      }
    }
    await visit(start, inherited);
    return { seen, discoveredContexts };
  }

  function accept(result) {
    for (const file of result.seen) covered.add(file);
    contexts.push(...result.discoveredContexts);
  }
  for (const [entry] of entries)
    accept(await visitRoot(entry, path.dirname(entry), []));
  for (const file of images.keys()) {
    if (covered.has(file)) continue;
    let success;
    const errors = new Set();
    for (const context of contexts) {
      try {
        success = await visitRoot(
          file,
          context.executableDirectory,
          context.rpaths,
        );
        break;
      } catch (error) {
        errors.add(error.message);
      }
    }
    if (!success)
      throw new Error(
        `Unresolved dynamically loaded image ${path.relative(root, file)}:\n${[...errors].join("\n")}`,
      );
    accept(success);
  }
  return covered.size;
}

const machoMagic = new Set([
  "feedface",
  "cefaedfe",
  "feedfacf",
  "cffaedfe",
  "cafebabe",
  "bebafeca",
  "cafebabf",
  "bfbafeca",
]);

export async function verifyBundle(app, arch) {
  const expected = { x64: "x86_64", arm64: "arm64" }[arch];
  if (!expected) throw new Error("Expected target architecture x64 or arm64");
  const { root, files } = await auditBundleLinks(app);
  const images = new Map();
  let bindings = 0;
  for (const file of files) {
    const handle = await fs.open(file);
    const header = Buffer.alloc(4);
    try {
      await handle.read(header, 0, 4, 0);
    } finally {
      await handle.close();
    }
    const native = file.endsWith(".node");
    if (!machoMagic.has(header.toString("hex"))) {
      if (native) throw new Error(`Native binding is not Mach-O: ${file}`);
      continue;
    }
    execFileSync("lipo", [file, "-verify_arch", expected], { stdio: "pipe" });
    // Electron helper names end in parentheses; -m disables archive(member)
    // interpretation so otool inspects the literal executable filename.
    const output = execFileSync(
      "otool",
      ["-m", "-arch", expected, "-l", file],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    images.set(file, parseMachOLoadCommands(output));
    if (native) bindings++;
  }
  const executable = execFileSync(
    "plutil",
    [
      "-extract",
      "CFBundleExecutable",
      "raw",
      "-o",
      "-",
      path.join(root, "Contents/Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
  if (!executable || path.basename(executable) !== executable)
    throw new Error("Invalid CFBundleExecutable");
  const mainExecutable = await fs.realpath(
    path.join(root, "Contents/MacOS", executable),
  );
  if (bindings < 3)
    throw new Error(
      `Expected at least three native bindings, found ${bindings}`,
    );
  await verifyMachODependencies({ root, images, mainExecutable });
  return { images: images.size, bindings, arch: expected };
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const result = await verifyBundle(process.argv[2], process.argv[3]);
    console.log(
      `Verified ${result.images} Mach-O images, ${result.bindings} native bindings, portable links and dependency closure for ${result.arch}; runtime not executed`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
