// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { verifyMergeSourceContracts } from "./verify-merge-source-contracts.mjs";

function fixture(callback) {
  const root = mkdtempSync(join(tmpdir(), "myoxus-merge-contract-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 5_000 });
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const commit = () => {
    git(["add", "."]);
    git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@myoxus.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  try {
    git(["init", "--quiet"]);
    write(
      "package.json",
      JSON.stringify({
        name: "fixture",
        dependencies: { declared: "1.0.0", "@myoxus/shared": "workspace:*" },
      }),
    );
    callback({ root, git, write, commit });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("unchanged consumers detect removed relative targets, named exports and workspace subpaths", () => {
  fixture(({ root, write, commit }) => {
    write("src/value.ts", "export const value = 1;\n");
    write(
      "src/consumer.ts",
      'import { value } from "./value"; import { shared } from "@myoxus/shared/public"; void value; void shared;\n',
    );
    write(
      "shared/package.json",
      JSON.stringify({
        name: "@myoxus/shared",
        exports: { "./public": "./public.ts" },
      }),
    );
    write("shared/public.ts", "export const shared = 2;\n");
    const base = commit();
    write("src/value.ts", "export const replacement = 1;\n");
    write(
      "shared/package.json",
      JSON.stringify({
        name: "@myoxus/shared",
        exports: { "./other": "./public.ts" },
      }),
    );
    commit();
    const findings = verifyMergeSourceContracts(root, base);
    assert.ok(
      findings.some((value) => value.includes("missing named export value")),
    );
    assert.ok(
      findings.some((value) =>
        value.includes("missing source/export target @myoxus/shared/public"),
      ),
    );
  });
  fixture(({ root, write, commit }) => {
    write("src/value.ts", "export const value = 1;\n");
    write("src/consumer.ts", 'import { value } from "./value"; void value;\n');
    const base = commit();
    rmSync(join(root, "src/value.ts"));
    commit();
    assert.ok(
      verifyMergeSourceContracts(root, base).some((value) =>
        value.includes("missing source/export target ./value"),
      ),
    );
  });
});

test("detects removed declarations, barrel regressions and empty exports without laundering old debt", () => {
  fixture(({ root, write, commit }) => {
    write("src/value.ts", "export const value = 1;\n");
    write("src/barrel.ts", 'export { value } from "./value";\n');
    write("src/consumer.ts", 'import { value } from "declared"; void value;\n');
    write("src/old.ts", 'import { old } from "old-debt"; void old;\n');
    const base = commit();
    write("src/value.ts", "export {};\n");
    write("package.json", JSON.stringify({ name: "fixture" }));
    commit();
    const findings = verifyMergeSourceContracts(root, base);
    assert.ok(
      findings.some((value) =>
        value.includes("undeclared dependency declared"),
      ),
    );
    assert.ok(
      findings.some((value) => value.includes("missing named export value")),
    );
    assert.ok(!findings.some((value) => value.includes("old-debt")));
  });
});

test("a real source merge catches independent same-ID SQL additions without running the server", () => {
  fixture(({ root, git, write, commit }) => {
    const base = commit();
    write(
      "server/crates/infrastructure/migrations/1020_target.sql",
      "SELECT 1;\n",
    );
    const target = commit();
    git(["checkout", "--quiet", "--detach", base]);
    write(
      "server/crates/infrastructure/migrations/01020_pr.sql",
      "SELECT 2;\n",
    );
    const head = commit();
    const tree = git(["merge-tree", "--write-tree", target, head]).trim();
    const merged = execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@myoxus.invalid",
        "commit-tree",
        tree,
        "-p",
        target,
        "-p",
        head,
      ],
      { cwd: root, input: "candidate\n", encoding: "utf8", timeout: 5_000 },
    ).trim();
    git(["checkout", "--quiet", "--detach", merged]);
    assert.ok(
      verifyMergeSourceContracts(root, target).some((value) =>
        value.includes("duplicate SQL migration 1020"),
      ),
    );
  });
});

test("valid re-exports and unrelated documentation preserve existing contracts", () => {
  fixture(({ root, write, commit }) => {
    write("src/value.ts", "export const value = 1;\n");
    write("src/barrel.ts", 'export * from "./value";\n');
    write("src/consumer.ts", 'import { value } from "./barrel"; void value;\n');
    const base = commit();
    write("src/value.ts", "export const value = 2;\n");
    commit();
    assert.deepEqual(verifyMergeSourceContracts(root, base), []);
    const next = commit;
    write("docs/example.md", "Documentation only\n");
    next();
    assert.deepEqual(verifyMergeSourceContracts(root, base), []);
  });
});

test("sparse source checks tolerate documentation moves without fetching omitted blobs", () => {
  fixture(({ root, git, write, commit }) => {
    write("src/value.ts", "export const value = 1;\n");
    const document = Array.from(
      { length: 100 },
      (_, i) => `Section ${i}\n`,
    ).join("");
    write("docs/original.md", document);
    const base = commit();
    const omitted = git(["rev-parse", `${base}:docs/original.md`]).trim();
    rmSync(join(root, "docs/original.md"));
    write("docs/archive.md", document + "Archived\n");
    write("src/value.ts", "export const value = 2;\n");
    const head = commit();
    git(["config", "uploadpack.allowFilter", "true"]);
    const candidate = join(root, "sparse-candidate");
    git([
      "clone",
      "--quiet",
      "--filter=blob:none",
      "--no-checkout",
      pathToFileURL(root).href,
      candidate,
    ]);
    const sparseGit = (args) =>
      execFileSync("git", args, {
        cwd: candidate,
        encoding: "utf8",
        timeout: 5_000,
      });
    sparseGit(["sparse-checkout", "set", "--no-cone", "*.ts", "*.json"]);
    sparseGit(["checkout", "--quiet", "--detach", base]);
    sparseGit(["checkout", "--quiet", "--detach", head]);
    sparseGit(["config", "diff.renames", "true"]);
    // The trusted checker has no checkout credential. Omitted documentation
    // must stay omitted after the authenticated source materialization phase.
    sparseGit([
      "remote",
      "set-url",
      "origin",
      pathToFileURL(join(root, "unavailable")).href,
    ]);
    const missing = () =>
      sparseGit(["rev-list", "--objects", "--all", "--missing=print"]);
    assert.ok(missing().includes(`?${omitted}`));
    assert.deepEqual(verifyMergeSourceContracts(candidate, base), []);
    assert.ok(missing().includes(`?${omitted}`));
  });
});

test("changed modules and workspace export maps reach unchanged star-barrel consumers", () => {
  fixture(({ root, write, commit }) => {
    write(
      "shared/package.json",
      JSON.stringify({ name: "@myoxus/shared", exports: "./value.ts" }),
    );
    write("shared/value.ts", "export const value = 1;\n");
    write("shared/other.ts", "export const other = 2;\n");
    write("src/barrel.ts", 'export * from "@myoxus/shared";\n');
    write("src/second-barrel.ts", 'export * from "./barrel";\n');
    write(
      "src/consumer.ts",
      'import { value } from "./second-barrel"; void value;\n',
    );
    const base = commit();
    write(
      "shared/package.json",
      JSON.stringify({ name: "@myoxus/shared", exports: "./other.ts" }),
    );
    commit();
    assert.ok(
      verifyMergeSourceContracts(root, base).some((value) =>
        value.includes("src/consumer.ts:1: missing named export value"),
      ),
    );
  });
});
