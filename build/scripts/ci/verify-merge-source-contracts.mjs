// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectModuleReferences,
  parseSource,
  walkAst,
} from "./source-imports.mjs";
import { findUndeclaredReferences } from "./verify-workspace-dependency-boundaries.mjs";
import { verifySourceTools } from "./source-tools.mjs";

const sourcePattern = /\.[cm]?[jt]sx?$/;
const migrations = "server/crates/infrastructure/migrations/";

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function tree(root, revision) {
  const files = new Map(
    git(root, ["ls-tree", "-rz", revision])
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const [metadata, path] = entry.split("\t");
        return [path, metadata.split(" ")[2]];
      }),
  );
  const content = new Map();
  // Read target source blobs in one Git process; one `git show` per consumer
  // would turn this static check into thousands of subprocesses.
  if (revision !== "HEAD") {
    const hashes = [
      ...new Set(
        [...files]
          .filter(
            ([path]) =>
              sourcePattern.test(path) || path.endsWith("package.json"),
          )
          .map(([, hash]) => hash),
      ),
    ];
    const output = execFileSync("git", ["cat-file", "--batch"], {
      cwd: root,
      input: hashes.join("\n") + "\n",
      timeout: 10_000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const blobs = new Map();
    let offset = 0;
    for (const hash of hashes) {
      const end = output.indexOf(10, offset);
      const size = Number(
        output.subarray(offset, end).toString("utf8").split(" ")[2],
      );
      if (!Number.isSafeInteger(size))
        throw new Error("Invalid Git source blob");
      blobs.set(
        hash,
        output.subarray(end + 1, end + 1 + size).toString("utf8"),
      );
      offset = end + 1 + size + 1;
    }
    for (const [path, hash] of files)
      if (blobs.has(hash)) content.set(path, blobs.get(hash));
  }
  const manifests = new Map();
  function read(path) {
    if (!files.has(path)) return null;
    if (!content.has(path))
      content.set(
        path,
        revision === "HEAD"
          ? readFileSync(resolve(root, path), "utf8")
          : git(root, ["show", `${revision}:${path}`]),
      );
    return content.get(path);
  }
  for (const path of files.keys()) {
    if (path.endsWith("package.json"))
      manifests.set(path, JSON.parse(read(path)));
  }
  const packages = new Map(
    [...manifests]
      .filter(([, manifest]) => manifest.name)
      .map(([path, manifest]) => [manifest.name, { path, manifest }]),
  );
  function owner(file) {
    for (let directory = dirname(file); ; directory = dirname(directory)) {
      const path =
        directory === "." ? "package.json" : `${directory}/package.json`;
      if (manifests.has(path)) return { path, manifest: manifests.get(path) };
      if (directory === ".") return null;
    }
  }
  function local(path) {
    const normalized = posix.normalize(path);
    const stem = normalized.replace(/\.[cm]?js$/, "");
    return (
      [
        normalized,
        ...[".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(
          (ext) => stem + ext,
        ),
        ...[".ts", ".tsx", ".js", ".jsx"].map(
          (ext) => `${normalized}/index${ext}`,
        ),
      ].find((candidate) => files.has(candidate)) ?? null
    );
  }
  function targets(value) {
    if (typeof value === "string") return [value];
    if (value && typeof value === "object")
      return Object.values(value).flatMap(targets);
    return [];
  }
  function resolveReference(file, specifier) {
    if (specifier.includes("?")) return { known: false };
    if (specifier.startsWith("."))
      return { known: true, path: local(posix.join(dirname(file), specifier)) };
    const name = specifier.startsWith("@")
      ? specifier.split("/").slice(0, 2).join("/")
      : specifier.split("/")[0];
    const workspace = packages.get(name);
    if (!workspace) return { known: false };
    const subpath =
      specifier === name ? "." : `.${specifier.slice(name.length)}`;
    const exports = workspace.manifest.exports;
    let candidates;
    if (exports !== undefined) {
      const mapping =
        exports &&
        typeof exports === "object" &&
        Object.keys(exports).some((key) => key.startsWith("."))
          ? exports
          : { ".": exports };
      candidates = targets(mapping[subpath]);
      if (!candidates.length) {
        const pattern = Object.keys(mapping)
          .filter((key) => key.includes("*"))
          .sort((a, b) => b.length - a.length)
          .find(
            (key) =>
              subpath.startsWith(key.split("*")[0]) &&
              subpath.endsWith(key.split("*")[1]),
          );
        if (pattern) {
          const [prefix, suffix] = pattern.split("*");
          const capture = subpath.slice(
            prefix.length,
            suffix ? -suffix.length : undefined,
          );
          candidates = targets(mapping[pattern]).map((value) =>
            value.replaceAll("*", capture),
          );
        }
      }
    } else {
      candidates =
        subpath === "."
          ? [
              workspace.manifest.source,
              workspace.manifest.module,
              workspace.manifest.main,
              "./index",
            ].filter(Boolean)
          : [subpath];
    }
    return {
      known: true,
      path:
        candidates
          .map((candidate) =>
            local(posix.join(dirname(workspace.path), candidate)),
          )
          .find(Boolean) ?? null,
    };
  }
  const symbols = new Map();
  function exportedNames(path, visited = new Set()) {
    if (!sourcePattern.test(path)) return null;
    if (symbols.has(path)) return symbols.get(path);
    if (visited.has(path)) return new Set();
    visited = new Set([...visited, path]);
    const names = new Set();
    const ast = parseSource(path, read(path));
    let unknown = false;
    walkAst(ast, (node) => {
      if (
        node.type === "MemberExpression" &&
        ["module", "exports"].includes(node.object?.value)
      )
        unknown = true;
    });
    for (const node of ast.body) {
      if (node.type === "ExportDeclaration") {
        const declaration = node.declaration;
        const name = declaration.identifier?.value ?? declaration.id?.value;
        if (name) names.add(name);
        for (const binding of declaration.declarations ?? []) {
          if (binding.id.type === "Identifier") names.add(binding.id.value);
          else unknown = true;
        }
      } else if (node.type === "ExportNamedDeclaration") {
        for (const item of node.specifiers)
          names.add((item.exported ?? item.orig ?? item.name)?.value);
      } else if (node.type === "ExportAllDeclaration") {
        const target = resolveReference(path, node.source.value).path;
        if (target)
          for (const name of exportedNames(target, visited) ?? [])
            if (name !== "default") names.add(name);
      } else if (node.type.startsWith("ExportDefault")) names.add("default");
    }
    const result = unknown ? null : names;
    if (visited.size === 1) symbols.set(path, result);
    return result;
  }
  function failures(file, reference) {
    const errors = [];
    const manifest = owner(file)?.manifest;
    if (manifest && findUndeclaredReferences(manifest, [reference]).length)
      errors.push(`undeclared dependency ${reference.specifier}`);
    const target = resolveReference(file, reference.specifier);
    if (target.known && !target.path)
      errors.push(`missing source/export target ${reference.specifier}`);
    if (target.path && reference.importedNames.length) {
      const names = exportedNames(target.path);
      // Only compare names the AST can prove; destructured exports, CommonJS,
      // external packages and bundler aliases remain consuming-typecheck work.
      if (names)
        for (const name of reference.importedNames)
          if (!names.has(name))
            errors.push(
              `missing named export ${name} from ${reference.specifier}`,
            );
    }
    return errors;
  }
  return { files, read, failures, resolveReference, owner, manifests };
}

export function verifyMergeSourceContracts(root, base) {
  // Rename similarity would fetch omitted documentation blobs after checkout
  // credentials are removed. Source contracts need both paths, not similarity.
  const changed = git(root, [
    "diff",
    "--no-renames",
    "--name-only",
    "-z",
    base,
    "HEAD",
  ])
    .split("\0")
    .filter(Boolean);
  const findings = [];
  if (changed.some((path) => path.startsWith(migrations))) {
    const versions = new Map();
    const current = git(root, [
      "ls-tree",
      "-r",
      "--name-only",
      "HEAD",
      migrations,
    ])
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const path of current) {
      const id = path.slice(migrations.length).match(/^(\d+)_.+\.sql$/)?.[1];
      if (!id) continue;
      const version = BigInt(id).toString();
      if (versions.has(version))
        findings.push(
          `duplicate SQL migration ${version}: ${versions.get(version)} and ${path}`,
        );
      versions.set(version, path);
    }
  }
  if (
    !changed.some(
      (path) => sourcePattern.test(path) || path.endsWith("package.json"),
    )
  )
    return findings;
  const current = tree(root, "HEAD");
  const target = tree(root, base);
  const changedSet = new Set(changed);
  const affectedModules = new Set(changed);
  const changedPackages = new Set(
    changed
      .filter((path) => path.endsWith("package.json"))
      .flatMap((path) => [
        current.manifests.get(path)?.name,
        target.manifests.get(path)?.name,
      ])
      .filter(Boolean),
  );
  const referencesByFile = new Map();
  const reverseExports = new Map();
  // Parse the source inventory once, but validate only touched sources, owners
  // and references to changed modules (including transitive barrel exports).
  // Unrelated import graphs are neither relinted nor revalidated.
  for (const file of current.files.keys()) {
    if (
      !sourcePattern.test(file) ||
      /(?:\.d\.[cm]?ts$|\.gen\.[cm]?ts$)/.test(file)
    )
      continue;
    const references = collectModuleReferences(file, current.read(file), {
      includeExportNames: true,
    });
    referencesByFile.set(file, references);
    for (const reference of references) {
      if (reference.kind !== "export") continue;
      const name = reference.specifier.startsWith("@")
        ? reference.specifier.split("/").slice(0, 2).join("/")
        : reference.specifier.split("/")[0];
      if (changedPackages.has(name)) affectedModules.add(file);
      const path =
        current.resolveReference(file, reference.specifier).path ??
        target.resolveReference(file, reference.specifier).path;
      if (!path) continue;
      if (!reverseExports.has(path)) reverseExports.set(path, new Set());
      reverseExports.get(path).add(file);
    }
  }
  const queue = [...affectedModules];
  for (const module of queue) {
    for (const consumer of reverseExports.get(module) ?? []) {
      if (affectedModules.has(consumer)) continue;
      affectedModules.add(consumer);
      queue.push(consumer);
    }
  }
  for (const [file, references] of referencesByFile) {
    const ownerChanged = changedSet.has(current.owner(file)?.path);
    let oldReferences;
    for (const reference of references) {
      const name = reference.specifier.startsWith("@")
        ? reference.specifier.split("/").slice(0, 2).join("/")
        : reference.specifier.split("/")[0];
      const path =
        current.resolveReference(file, reference.specifier).path ??
        target.resolveReference(file, reference.specifier).path;
      if (
        !changedSet.has(file) &&
        !ownerChanged &&
        !affectedModules.has(path) &&
        !changedPackages.has(name)
      )
        continue;
      const failures = current.failures(file, reference);
      if (!failures.length) continue;
      oldReferences ??= target.files.has(file)
        ? collectModuleReferences(file, target.read(file), {
            includeExportNames: true,
          })
        : [];
      const previous = oldReferences.find(
        (item) =>
          item.specifier === reference.specifier &&
          item.kind === reference.kind &&
          JSON.stringify(item.importedNames) ===
            JSON.stringify(reference.importedNames),
      );
      const existing = previous ? target.failures(file, previous) : [];
      for (const failure of failures)
        if (!existing.includes(failure))
          findings.push(`${file}:${reference.line}: ${failure}`);
    }
  }
  return findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [base, directory = process.cwd()] = process.argv.slice(2);
  if (!/^[a-f0-9]{40,64}$/.test(base ?? ""))
    throw new Error("Verified target SHA required");
  verifySourceTools(directory);
  const started = Date.now();
  const findings = verifyMergeSourceContracts(resolve(directory), base);
  for (const finding of findings) console.error(finding);
  console.log(
    `Merge source contracts: ${findings.length} findings, ${Date.now() - started} ms; no product tests/builds`,
  );
  if (findings.length) process.exitCode = 1;
}
