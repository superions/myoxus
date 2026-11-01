#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);

function option(name, fallback = undefined) {
  const prefix = `${name}=`;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) return args[index + 1] ?? fallback;
    if (args[index].startsWith(prefix)) return args[index].slice(prefix.length);
  }
  return fallback;
}

if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: test-skill-scripts.mjs [--repo <repo-root>]");
  process.exit(0);
}

const defaultRepo = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repo = path.resolve(option("--repo", defaultRepo));
const skillsRoot = path.join(repo, ".agents/skills");
const failures = [];

function run(label, command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd ?? repo,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const passed = options.expectFailure
    ? result.status !== 0
    : result.status === 0;
  if (!passed || result.error) {
    failures.push(
      `${label}: status=${result.status} error=${result.error?.message ?? "none"}\n${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function walkScripts(root) {
  const result = [];
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    if (statSync(full).isDirectory()) result.push(...walkScripts(full));
    else if (full.endsWith(".mjs")) result.push(full);
  }
  return result;
}

run("skill validator", process.execPath, [
  path.join(repo, "tools/codex/validate-skills.mjs"),
  "--repo",
  repo,
]);
run("TODO issue source and dependency invariants", process.execPath, [
  path.join(skillsRoot, "myoxus-todo-to-issue/scripts/test-todo-issues.mjs"),
]);
run("Forgejo request and temporary token lifecycle", process.execPath, [
  path.join(
    skillsRoot,
    "myoxus-forgejo-temporary-token/scripts/test-forgejo-tools.mjs",
  ),
]);
for (const script of walkScripts(skillsRoot)) {
  run(`${path.relative(repo, script)} --help`, process.execPath, [
    script,
    "--help",
  ]);
}

const temp = mkdtempSync(path.join(os.tmpdir(), "myoxus-skills-"));
try {
  const i18nRoot = path.join(temp, "i18n");
  const resources = path.join(i18nRoot, "client/libs/i18n/src/resources");
  mkdirSync(resources, { recursive: true });
  const translations = {
    Cancel: "Cancel",
    "app.cancel": "Cancel",
    "app.view.table": "Table {{count}}",
    "app.view.board": "Board {{count}}",
  };
  writeFileSync(path.join(resources, "en.json"), JSON.stringify(translations));
  writeFileSync(
    path.join(resources, "de.json"),
    JSON.stringify({
      Cancel: "Abbrechen",
      "app.cancel": "Abbrechen",
      "app.view.table": "Tabelle {{count}}",
      "app.view.board": "Board {{count}}",
    }),
  );
  for (const [locale, cancel, table, board] of [
    ["fr", "Annuler", "Tableau {{count}}", "Tableau de bord {{count}}"],
    ["es", "Cancelar", "Tabla {{count}}", "Tablero {{count}}"],
  ]) {
    writeFileSync(
      path.join(resources, `${locale}.json`),
      JSON.stringify({
        Cancel: cancel,
        "app.cancel": cancel,
        "app.view.table": table,
        "app.view.board": board,
      }),
    );
  }
  // Optional coverage must not block either valid lookups or duplicate detection.
  writeFileSync(path.join(resources, "it.json"), "{}");
  writeFileSync(
    path.join(i18nRoot, "client/libs/i18n/src/i18n.gen.ts"),
    '["Cancel"](): string;\n["app.cancel"](): string;\n["app.view.table"](): string;\n["app.view.board"](): string;\n',
  );
  writeFileSync(
    path.join(i18nRoot, "valid.tsx"),
    'const keys = { table: "app.view.table", board: "app.view.board" } as const;\nt[keys[kind]]({ count: 1 });\n',
  );
  writeFileSync(
    path.join(i18nRoot, "dynamic.tsx"),
    "t[`app.view.${kind}`]({ count: 1 });\n",
  );
  const i18nAudit = path.join(
    skillsRoot,
    "myoxus-i18n-codegen/scripts/audit-i18n-change.mjs",
  );
  run("i18n static map", process.execPath, [
    i18nAudit,
    "--repo",
    i18nRoot,
    "--source",
    "valid.tsx",
  ]);
  run(
    "i18n dynamic key rejection",
    process.execPath,
    [i18nAudit, "--repo", i18nRoot, "--source", "dynamic.tsx"],
    { expectFailure: true },
  );
  writeFileSync(
    path.join(i18nRoot, "admin.tsx"),
    'const keys = { table: "app.view.table" } as const;\ni18n.t(keys[kind], { count: 1 });\ni18n.t("app.view.board", { count: 2 });\n',
  );
  run("i18n Admin call syntax", process.execPath, [
    i18nAudit,
    "--repo",
    i18nRoot,
    "--source",
    "admin.tsx",
  ]);
  for (const expression of ['"missing.admin.key"', "`app.view.${kind}`"]) {
    writeFileSync(
      path.join(i18nRoot, "admin-invalid.tsx"),
      `t["Cancel"](); i18n.t(${expression}, { count: 1 });`,
    );
    run(
      "i18n Admin missing or dynamic key rejection",
      process.execPath,
      [i18nAudit, "--repo", i18nRoot, "--source", "admin-invalid.tsx"],
      { expectFailure: true },
    );
  }
  run(
    "i18n global duplicate rejection",
    process.execPath,
    [i18nAudit, "--repo", i18nRoot, "--keys", "app.cancel"],
    { expectFailure: true },
  );
  run("i18n reviewed domain exception", process.execPath, [
    i18nAudit,
    "--repo",
    i18nRoot,
    "--keys",
    "app.cancel",
    "--allow-domain-specific",
    "app.cancel",
  ]);

  const mainLocalePath = path.join(resources, "fr.json");
  const completeFrench = readFileSync(mainLocalePath, "utf8");
  const expectI18nFailure = (label, expectedMessage) => {
    const result = run(
      label,
      process.execPath,
      [i18nAudit, "--repo", i18nRoot, "--keys", "app.view.table"],
      { expectFailure: true },
    );
    if (!result.stderr.includes(expectedMessage)) {
      failures.push(`${label}: missing expected diagnostic ${expectedMessage}`);
    }
  };
  writeFileSync(mainLocalePath, "{}");
  expectI18nFailure("i18n missing main-language key", "fr.json missing key");
  rmSync(mainLocalePath);
  expectI18nFailure(
    "i18n missing main-language file",
    "missing main-language resource: fr.json",
  );
  writeFileSync(mainLocalePath, JSON.stringify({ "app.view.table": " " }));
  expectI18nFailure(
    "i18n empty main-language value",
    "empty or non-string translation",
  );
  writeFileSync(
    mainLocalePath,
    JSON.stringify({ "app.view.table": "Tableau {{name}}" }),
  );
  expectI18nFailure(
    "i18n main-language placeholders",
    "fr.json placeholder mismatch",
  );
  writeFileSync(mainLocalePath, completeFrench);
  writeFileSync(
    path.join(resources, "it.json"),
    JSON.stringify({
      "app.view.table": "Tabella {{name}}",
    }),
  );
  expectI18nFailure(
    "i18n optional-language placeholders",
    "it.json placeholder mismatch",
  );
  writeFileSync(
    path.join(resources, "it.json"),
    JSON.stringify({
      "app.view.table": "Tabella {{count}}",
    }),
  );
  run("i18n partial optional translation", process.execPath, [
    i18nAudit,
    "--repo",
    i18nRoot,
    "--source",
    "valid.tsx",
  ]);

  const visualAudit = path.join(
    skillsRoot,
    "myoxus-visual-qa/scripts/audit-visual-evidence.mjs",
  );
  for (const phase of ["before", "after"]) {
    const dir = path.join(temp, phase);
    mkdirSync(dir);
    writeFileSync(
      path.join(dir, "all-light-desktop.png"),
      Buffer.alloc(512, 1),
    );
    writeFileSync(
      path.join(dir, "report.json"),
      JSON.stringify({
        failures: [],
        url: "http://localhost:3010/workspace/id/all",
        captures: [
          {
            theme: "light",
            viewport: { label: "desktop", width: 1440, height: 1000 },
            finalUrl: "http://localhost:3010/workspace/id/all",
            screenshot: "all-light-desktop.png",
            consoleMessages: [],
            pageErrors: [],
            workerErrors: [],
            interactionFailures: [],
            waitFailures: [],
            dom: {
              horizontalOverflow: false,
              requiredProbes: [{ label: "main", visibleCount: 1 }],
              requiredExists: [],
            },
          },
        ],
      }),
    );
  }
  run("visual matched pair", process.execPath, [
    visualAudit,
    "--before-dir",
    path.join(temp, "before"),
    "--after-dir",
    path.join(temp, "after"),
    "--expect-themes",
    "light",
    "--expect-viewports",
    "desktop",
  ]);
  const badReport = JSON.parse(
    readFileSync(path.join(temp, "after/report.json"), "utf8"),
  );
  badReport.captures[0].consoleMessages.push({ type: "error", text: "boom" });
  writeFileSync(
    path.join(temp, "after/report.json"),
    JSON.stringify(badReport),
  );
  run(
    "visual console rejection",
    process.execPath,
    [visualAudit, "--dir", path.join(temp, "after")],
    { expectFailure: true },
  );
  badReport.captures[0].consoleMessages = [];
  badReport.captures[0].finalUrl = "http://localhost:3010/sign-in";
  writeFileSync(
    path.join(temp, "after/report.json"),
    JSON.stringify(badReport),
  );
  run(
    "visual auth redirect rejection",
    process.execPath,
    [visualAudit, "--dir", path.join(temp, "after")],
    { expectFailure: true },
  );
  badReport.captures[0].finalUrl = "http://localhost:3010/workspace/id/all";
  badReport.captures[0].theme = "dark";
  writeFileSync(
    path.join(temp, "after/report.json"),
    JSON.stringify(badReport),
  );
  run(
    "visual pair coverage rejection",
    process.execPath,
    [
      visualAudit,
      "--before-dir",
      path.join(temp, "before"),
      "--after-dir",
      path.join(temp, "after"),
    ],
    { expectFailure: true },
  );

  const selector = path.join(
    skillsRoot,
    "myoxus-test-gates/scripts/select-gates.mjs",
  );
  const selected = run("matrix selector", process.execPath, [
    selector,
    "--repo",
    repo,
    "--files",
    "AGENTS.md",
    "--json",
  ]);
  if (selected.status === 0) {
    try {
      JSON.parse(selected.stdout);
    } catch (error) {
      failures.push(`matrix selector returned invalid JSON: ${error.message}`);
    }
  }

  const stackSnapshot = path.join(
    skillsRoot,
    "myoxus-dev-runtime/scripts/stack-snapshot.mjs",
  );
  run("dev runtime snapshot", process.execPath, [
    stackSnapshot,
    "--repo",
    repo,
  ]);
} finally {
  rmSync(temp, { force: true, recursive: true });
}

if (failures.length > 0) {
  for (const failure of failures) console.error(`[FAIL] ${failure}`);
  process.exit(1);
}

console.log("skill-script-tests: ok");
