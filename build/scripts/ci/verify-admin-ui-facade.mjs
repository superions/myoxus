#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const args = new Set(process.argv.slice(2));
const reportMode = args.has("--report") || args.size === 0;
const docsCheckMode = args.has("--docs-check");
const finalCheckMode = args.has("--check") || args.has("--final-check");
const verboseMode = args.has("--verbose");

const adminRoot = resolve(repoRoot, "client/admin/workspaces/admin");
const adminSrc = resolve(adminRoot, "src");
const matrixPath = resolve(
  repoRoot,
  "docs/dev/clients/adminfrontend/admin-ui-facade-route-matrix.json",
);
const appPath = resolve(adminSrc, "app.tsx");

const removedImplementationSources = [
  "todo/admin-redesign-concept.md",
  "todo/admin-redesign-todos.md",
  "docs/dev/clients/adminfrontend/atelier-notebook-design-system.md",
  "docs/dev/clients/adminfrontend/design/05-redesign-history.md",
  "docs/dev/clients/adminfrontend/design/archive/pre-consolidation-migration-map.md",
];

const activeAdminDocs = [
  "todo/adminfrontend.md",
  "todo/server.md",
  "todo/webfrontend.md",
  "docs/dev/clients/adminfrontend/README.md",
  "docs/dev/clients/adminfrontend/architecture.md",
  "docs/dev/clients/adminfrontend/modules.md",
  "docs/dev/clients/adminfrontend/ui-facade-architecture.md",
  "docs/dev/clients/adminfrontend/admin-ui-facade-route-matrix.md",
  "docs/dev/clients/adminfrontend/design/README.md",
  "docs/dev/clients/adminfrontend/design/00-contract.md",
  "docs/dev/clients/adminfrontend/design/01-tokens-theming.md",
  "docs/dev/clients/adminfrontend/design/02-components.md",
  "docs/dev/clients/adminfrontend/design/03-layout-patterns.md",
  "docs/dev/clients/adminfrontend/design/04-visual-qa.md",
  "docs/test/client/frontend-hardening.md",
  "docs/test/client/frontend-release-gate.md",
];

const activeAdminDocForbiddenPatterns = [
  {
    id: "removed-admin-design-doc-reference",
    regexp:
      /admin-redesign-(?:concept|todos)|atelier-notebook-design-system|05-redesign-history|pre-consolidation-migration-map/i,
  },
  {
    id: "removed-local-admin-ui-language",
    regexp:
      /\bAtelier\b|\bPaperButton\b|\bPaperCard\b|\bPaper\*\b|components\/atelier|pdf-atelier|git-sync-atelier|queue-atelier|template-atelier/i,
  },
];

const scanRoots = [
  "client/admin/workspaces/admin/package.json",
  "client/admin/workspaces/admin/components.json",
  "client/admin/workspaces/admin/tailwind.config.js",
  "client/admin/workspaces/admin/tailwind.config.ts",
  "client/admin/workspaces/admin/postcss.config.js",
  "client/admin/workspaces/admin/postcss.config.ts",
  "client/admin/workspaces/admin/src",
  "tests/client/adminfrontend/e2e",
];

const outputRoots = [
  "client/admin/workspaces/admin/dist",
  "client/frontends/static/admin",
];

const ignoredPathParts = new Set([
  ".git",
  ".turbo",
  ".yarn",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);

const scannedExtensions = new Set([
  ".css",
  ".cjs",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);

const legacyPatterns = [
  {
    id: "radix-direct-import",
    pattern: "@radix-ui/",
    severity: "final",
  },
  {
    id: "mantine-direct-import",
    pattern: "@mantine/",
    severity: "final",
    allowedPathParts: [
      "src/ui-facade/",
      "src/components/myoxus-ui/",
      "src/providers/",
    ],
  },
  {
    id: "admin-ui-wrapper-import",
    pattern: "@myoxus/admin/components/ui/",
    severity: "final",
  },
  {
    id: "components-ui-import",
    regexp: /from\s+["'][^"']*components\/ui\/[^"']+["']/,
    severity: "final",
  },
  {
    id: "components-ui-reference",
    regexp: /["'][^"']*components\/ui\/[^"']+["']/,
    severity: "final",
  },
  {
    id: "removed-admin-local-namespace-reference",
    regexp:
      /components\/atelier|pdf-atelier|git-sync-atelier|queue-atelier|template-atelier|document-atelier|ai-atelier/,
    severity: "final",
  },
  {
    id: "removed-admin-local-paper-primitive",
    regexp: /\bPaperButton\b|\bPaperCard\b|data-atelier-tone|atelier-/,
    severity: "final",
  },
  {
    id: "sonner-direct-reference",
    regexp: /["']sonner["']/,
    severity: "final",
  },
  {
    id: "tailwind-css-directive",
    regexp: /@(tailwind|apply|config|plugin|theme|utility|custom-variant)\b/,
    severity: "final",
  },
  {
    id: "tailwind-package",
    regexp: /"(tailwindcss|tailwindcss-animate|tailwind-merge)"\s*:/,
    severity: "final",
  },
  {
    id: "shadcn-package",
    regexp: /"(shadcn-ui)"\s*:/,
    severity: "final",
  },
  {
    id: "class-variance-authority-package",
    regexp: /"(class-variance-authority)"\s*:/,
    severity: "final",
  },
  {
    id: "clsx-package",
    regexp: /"(clsx)"\s*:/,
    severity: "final",
  },
  {
    id: "next-themes-package",
    regexp: /"(next-themes)"\s*:/,
    severity: "final",
  },
  {
    id: "sonner-package",
    regexp: /"(sonner)"\s*:/,
    severity: "final",
  },
  {
    id: "vaul-package",
    regexp: /"(vaul)"\s*:/,
    severity: "final",
  },
];

const tailwindUtilityTokenRegexp =
  /^(?:flex|grid|hidden|block|inline|inline-flex|inline-block|contents|sr-only|items-.+|justify-.+|content-.+|self-.+|place-.+|gap-.+|space-.+|p[trxylb]?-(?:\d.*|px|auto|\[.+\])|m[trxylb]?-(?:\d.*|px|auto|\[.+\])|h-.+|w-.+|min-h-.+|max-h-.+|min-w-.+|max-w-.+|size-.+|rounded(?:-.+)?|shadow(?:-.+)?|border(?:-.+)?|bg-.+|text-.+|dark:.+|font-.+|tracking-.+|leading-.+|uppercase|opacity-.+|shrink(?:-.+)?|grow(?:-.+)?|basis-.+|overflow-.+|relative|absolute|fixed|sticky|inset-.+|top-.+|right-.+|bottom-.+|left-.+|z-.+|cursor-.+|transition(?:-.+)?|duration-.+|ease-.+|-?translate-.+|backdrop-.+|[a-z]+:.+)$/;

function isTailwindUtilityToken(token) {
  if (
    token.startsWith("admin-") ||
    token.startsWith("org-") ||
    token === "group"
  ) {
    return false;
  }
  return tailwindUtilityTokenRegexp.test(token);
}

function collectClassStringMatches(source) {
  const matches = [];
  const directClassNames =
    /className\s*=\s*(?:"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`)/g;
  for (const match of source.matchAll(directClassNames)) {
    matches.push({
      value: match[1] ?? match[2] ?? match[3] ?? "",
      index: match.index ?? 0,
    });
  }

  const expressionClassNames = /className\s*=\s*\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(expressionClassNames)) {
    const expression = match[1] ?? "";
    for (const stringMatch of expression.matchAll(/["'`]([^"'`\n]*)["'`]/g)) {
      matches.push({
        value: stringMatch[1] ?? "",
        index: (match.index ?? 0) + (stringMatch.index ?? 0),
      });
    }
  }
  return matches;
}

function collectJsxOpeningTags(source, tagName) {
  const matches = [];
  const regexp = new RegExp(`<${tagName}(?=[\\s>])`, "g");
  let match;
  while ((match = regexp.exec(source)) !== null) {
    const startIndex = match.index ?? 0;
    let index = startIndex + tagName.length + 1;
    let braceDepth = 0;
    let quote = null;
    while (index < source.length) {
      const char = source[index];
      if (quote) {
        if (char === quote && source[index - 1] !== "\\") quote = null;
      } else if (char === '"' || char === "'" || char === "`") {
        quote = char;
      } else if (char === "{") {
        braceDepth += 1;
      } else if (char === "}") {
        braceDepth -= 1;
      } else if (char === ">" && braceDepth === 0) {
        break;
      }
      index += 1;
    }
    matches.push({
      tagName,
      block: source.slice(startIndex, index + 1),
      index: startIndex,
    });
  }
  return matches;
}

function classStringValuesFromOpeningTag(openingTag) {
  return collectClassStringMatches(openingTag).map((match) => match.value);
}

function hasSemanticAdminClass(openingTag) {
  return classStringValuesFromOpeningTag(openingTag).some((value) =>
    value
      .split(/\s+/)
      .filter(Boolean)
      .some(
        (token) =>
          token.startsWith("admin-") ||
          token.startsWith("org-") ||
          token.startsWith("myoxus-"),
      ),
  );
}

function hasExplicitRawControlRole(openingTag) {
  return (
    /data-myoxus-ui-role\s*=/.test(openingTag) ||
    /data-myoxus-native-control\s*=/.test(openingTag) ||
    hasSemanticAdminClass(openingTag)
  );
}

function isTechnicalNativeInput(openingTag) {
  return (
    /type\s*=\s*["'](?:hidden|file|color|radio)["']/.test(openingTag) ||
    /\bhidden\b/.test(openingTag) ||
    /\bwebkitdirectory\b/.test(openingTag)
  );
}

function collectRawControlFindingsFromSource(path, source) {
  const findings = [];
  const relativePath = rel(path);
  if (
    /\.spec\.[tj]sx?$/.test(relativePath) ||
    relativePath.includes("/__tests__/")
  ) {
    return findings;
  }
  const add = (tag, detail, index) => {
    findings.push({
      group: classifyPath(path),
      path: relativePath,
      line: lineNumberForIndex(source, Math.max(0, index)),
      rule: "raw-control-without-semantic-role",
      detail: `${tag}: ${detail}`,
    });
  };

  for (const tagName of ["button", "input", "select", "textarea", "table"]) {
    for (const tag of collectJsxOpeningTags(source, tagName)) {
      if (hasExplicitRawControlRole(tag.block)) continue;
      if (tagName === "input" && isTechnicalNativeInput(tag.block)) continue;
      add(
        tagName,
        "raw DOM control needs a facade primitive, semantic admin class or explicit native-control role",
        tag.index,
      );
    }
  }
  return findings;
}

function collectTailwindClassFindings(path, source) {
  const findings = [];
  for (const match of collectClassStringMatches(source)) {
    for (const token of match.value.split(/\s+/).filter(Boolean)) {
      if (!isTailwindUtilityToken(token)) continue;
      findings.push({
        group: classifyPath(path),
        path: rel(path),
        line: lineNumberForIndex(source, match.index),
        rule: "tailwind-utility-classname",
        detail: token,
      });
    }
  }
  return findings;
}

function validateTailwindTokenMatcher() {
  const sample = [
    'const a = <div className="p-8" />;',
    'const b = <div className="foo p-8" />;',
    'const c = <div className={cn("admin-card", "space-y-8")} />;',
  ].join("\n");
  const fakePath = resolve(adminSrc, "__guard_self_test__.tsx");
  const details = collectTailwindClassFindings(fakePath, sample).map(
    (finding) => finding.detail,
  );
  const expected = ["p-8", "p-8", "space-y-8"];
  if (
    details.length !== expected.length ||
    expected.some((detail, index) => details[index] !== detail)
  ) {
    throw new Error(
      `tailwind utility matcher self-test failed: got ${JSON.stringify(details)}`,
    );
  }
}

function rel(path) {
  return relative(repoRoot, path).replaceAll("\\", "/");
}

function pathParts(path) {
  return rel(path).split("/").filter(Boolean);
}

function isIgnored(path) {
  return pathParts(path).some((part) => ignoredPathParts.has(part));
}

function extensionOf(path) {
  const name = path.split(/[\\/]/).pop() ?? "";
  if (name.endsWith(".css.ts")) return ".css.ts";
  if (name.endsWith(".css.tsx")) return ".css.tsx";
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index);
}

function* walk(path) {
  if (!existsSync(path) || isIgnored(path)) return;
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      yield* walk(resolve(path, entry));
    }
    return;
  }
  if (!stat.isFile()) return;
  if (scannedExtensions.has(extensionOf(path))) {
    yield path;
  }
}

function classifyPath(path) {
  const relativePath = rel(path);
  if (relativePath.includes("/dist/") || relativePath.includes("/static/")) {
    return "static-output";
  }
  if (
    relativePath.includes("/tests/") ||
    /\.spec\.[tj]sx?$/.test(relativePath)
  ) {
    return "tests";
  }
  if (
    relativePath.endsWith("package.json") ||
    relativePath.endsWith("components.json")
  ) {
    return "package-build";
  }
  if (
    relativePath.endsWith("tailwind.config.js") ||
    relativePath.endsWith("tailwind.config.ts")
  ) {
    return "package-build";
  }
  if (relativePath.includes("/src/components/ui/")) {
    return "legacy-ui-wrappers";
  }
  if (relativePath.includes("/src/components/shared/")) {
    return "shared-primitives";
  }
  if (
    relativePath.includes("/src/modules/admin-shell/") ||
    relativePath.includes("/src/modules/nav/") ||
    relativePath.endsWith("/src/modules/layout.tsx") ||
    relativePath.includes("/src/components/theme-provider")
  ) {
    return "shell-provider";
  }
  const routeMatch = relativePath.match(/\/src\/modules\/([^/]+)/);
  if (routeMatch) return `route:${routeMatch[1]}`;
  return "admin-source";
}

function lineNumberForIndex(source, index) {
  return source.slice(0, index).split("\n").length;
}

function addFinding(findings, path, rule, detail, index = 0) {
  findings.push({
    group: classifyPath(path),
    path: rel(path),
    line: lineNumberForIndex(readFileSync(path, "utf8"), index),
    rule,
    detail,
  });
}

function collectLegacyFindings() {
  const findings = [];
  const roots = [...scanRoots, ...(finalCheckMode ? outputRoots : [])];
  for (const root of roots) {
    const absoluteRoot = resolve(repoRoot, root);
    for (const path of walk(absoluteRoot)) {
      const relativePath = rel(path);
      if (relativePath.includes("/src/components/ui/")) {
        findings.push({
          group: classifyPath(path),
          path: relativePath,
          line: 1,
          rule: "legacy-wrapper-file",
          detail: "components/ui is a transitional shadcn/Radix wrapper tree",
        });
      }
      if (relativePath.endsWith("components.json")) {
        findings.push({
          group: classifyPath(path),
          path: relativePath,
          line: 1,
          rule: "shadcn-components-json",
          detail: "shadcn registry metadata must disappear after cut-over",
        });
      }
      if (/tailwind\.config\.[jt]s$/.test(relativePath)) {
        findings.push({
          group: classifyPath(path),
          path: relativePath,
          line: 1,
          rule: "tailwind-config-file",
          detail: "tailwind config must disappear after cut-over",
        });
      }

      let source;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        continue;
      }

      for (const rule of legacyPatterns) {
        if (
          rule.id === "mantine-direct-import" &&
          classifyPath(path) === "static-output"
        ) {
          continue;
        }
        if (
          rule.allowedPathParts?.some((allowedPart) =>
            relativePath.includes(allowedPart),
          )
        ) {
          continue;
        }
        if (rule.pattern) {
          let index = source.indexOf(rule.pattern);
          while (index !== -1) {
            addFinding(findings, path, rule.id, rule.pattern, index);
            index = source.indexOf(rule.pattern, index + rule.pattern.length);
          }
          continue;
        }
        const match = source.match(rule.regexp);
        if (match) {
          addFinding(findings, path, rule.id, match[0], match.index ?? 0);
        }
      }
      findings.push(...collectTailwindClassFindings(path, source));
    }
  }
  return findings.sort((a, b) =>
    `${a.group}:${a.path}:${a.line}:${a.rule}`.localeCompare(
      `${b.group}:${b.path}:${b.line}:${b.rule}`,
    ),
  );
}

function collectAdminReductionFindingsFromSource(path, source) {
  const findings = [];
  const relativePath = rel(path);
  const add = (rule, detail, index) => {
    findings.push({
      group: classifyPath(path),
      path: relativePath,
      line: lineNumberForIndex(source, Math.max(0, index)),
      rule,
      detail,
    });
  };

  if (
    relativePath.endsWith("src/global.css") &&
    source.includes('.admin-page-subnav-surface [data-myoxus-ui-role="tabs-')
  ) {
    add(
      "admin-subnav-wide-facade-reskin",
      "Subnav CSS must target the explicit AdminSubnav classes, not generic facade roles.",
      source.indexOf('.admin-page-subnav-surface [data-myoxus-ui-role="tabs-'),
    );
  }

  for (const match of source.matchAll(
    /\badmin-role-(?:drop-zone|picker|surface-panel-accent|surface-panel-grain|tone-dot|empty-state-title|empty-state-hint|shoulder-stat-label)\b/g,
  )) {
    add(
      "removed-local-admin-role-widget",
      "Deleted Admin role widget chrome must not be reintroduced; use the facade-backed role primitive.",
      match.index ?? 0,
    );
  }

  if (
    relativePath.startsWith("client/admin/workspaces/admin/src/modules/") &&
    !relativePath.endsWith("src/modules/admin-shell/index.tsx")
  ) {
    const manualSubnav = /<AdminSubnav\b[\s\S]*?<TabsList\b/.exec(source);
    if (manualSubnav) {
      add(
        "admin-subnav-manual-tablist",
        "Top-level AdminSubnav consumers must pass item data; manual TabsList/TabsTrigger structures belong in AdminSubnav or explicit nested preview/drawer exceptions.",
        manualSubnav.index,
      );
    }
  }

  findings.push(...collectRawControlFindingsFromSource(path, source));

  return findings;
}

function collectAdminReductionFindings() {
  const findings = [];
  for (const path of walk(adminSrc)) {
    const relativePath = rel(path);
    if (!relativePath.endsWith(".tsx") && !relativePath.endsWith(".css")) {
      continue;
    }
    let source;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    findings.push(...collectAdminReductionFindingsFromSource(path, source));
  }
  return findings.sort((a, b) =>
    `${a.group}:${a.path}:${a.line}:${a.rule}`.localeCompare(
      `${b.group}:${b.path}:${b.line}:${b.rule}`,
    ),
  );
}

function validateAdminReductionMatchers() {
  const fakeRoutePath = resolve(
    adminSrc,
    "modules",
    "fake-admin-route",
    "index.tsx",
  );
  const fakeCssPath = resolve(adminSrc, "global.css");
  const fakeRouteFindings = collectAdminReductionFindingsFromSource(
    fakeRoutePath,
    '<AdminSubnav><TabsList><TabsTrigger value="x" /></TabsList></AdminSubnav>',
  );
  const fakeCssFindings = collectAdminReductionFindingsFromSource(
    fakeCssPath,
    '.admin-page-subnav-surface [data-myoxus-ui-role="tabs-trigger"] { color: red; }',
  );
  const fakeRawControlFindings = collectAdminReductionFindingsFromSource(
    fakeRoutePath,
    '<button type="button">Bad</button><input value="x" /><select><option>Bad</option></select><textarea />',
  );
  const fakeAllowedRawControlFindings = collectAdminReductionFindingsFromSource(
    fakeRoutePath,
    '<button type="button" className="admin-ui-chip">Ok</button><input type="file" hidden /><table className="admin-ui-table" />',
  );
  const fakeLocalWidgetFindings = collectAdminReductionFindingsFromSource(
    fakeRoutePath,
    '<div className="admin-role-drop-zone admin-role-picker-input" />',
  );
  if (
    !fakeRouteFindings.some(
      (finding) => finding.rule === "admin-subnav-manual-tablist",
    ) ||
    !fakeCssFindings.some(
      (finding) => finding.rule === "admin-subnav-wide-facade-reskin",
    ) ||
    fakeRawControlFindings.filter(
      (finding) => finding.rule === "raw-control-without-semantic-role",
    ).length !== 4 ||
    fakeAllowedRawControlFindings.some(
      (finding) => finding.rule === "raw-control-without-semantic-role",
    ) ||
    !fakeLocalWidgetFindings.some(
      (finding) => finding.rule === "removed-local-admin-role-widget",
    )
  ) {
    throw new Error("admin reduction matcher self-test failed");
  }
}

function lazyModulesFromApp() {
  const appSource = readFileSync(appPath, "utf8");
  return [
    ...appSource.matchAll(
      /import\s*\(\s*(?:\/\*[\s\S]*?\*\/\s*)?["']\.\/modules\/([^"']+)["']/g,
    ),
  ]
    .map((match) => match[1])
    .sort();
}

function validateAdminDocs() {
  const findings = [];
  for (const file of removedImplementationSources) {
    const path = resolve(repoRoot, file);
    if (existsSync(path)) {
      findings.push({
        group: "docs",
        path: file,
        line: 1,
        rule: "removed-doc-still-present",
        detail: "obsolete Admin design source must not remain in active paths",
      });
    }
  }

  for (const file of activeAdminDocs) {
    const path = resolve(repoRoot, file);
    if (!existsSync(path)) {
      findings.push({
        group: "docs",
        path: file,
        line: 1,
        rule: "active-doc-missing",
        detail: "active Admin UI contract document is missing",
      });
      continue;
    }
    const source = readFileSync(path, "utf8");
    for (const rule of activeAdminDocForbiddenPatterns) {
      const match = source.match(rule.regexp);
      if (!match) continue;
      findings.push({
        group: "docs",
        path: file,
        line: lineNumberForIndex(source, match.index ?? 0),
        rule: rule.id,
        detail: match[0],
      });
    }
  }
  return findings;
}

function validateMatrix() {
  const findings = [];
  if (!existsSync(matrixPath)) {
    return [
      {
        group: "docs",
        path: rel(matrixPath),
        line: 1,
        rule: "matrix-missing",
        detail: "Admin route/surface matrix is required",
      },
    ];
  }

  let matrix;
  try {
    matrix = JSON.parse(readFileSync(matrixPath, "utf8"));
  } catch (error) {
    return [
      {
        group: "docs",
        path: rel(matrixPath),
        line: 1,
        rule: "matrix-invalid-json",
        detail: error.message,
      },
    ];
  }

  const routes = Array.isArray(matrix.routes) ? matrix.routes : [];
  const lazyRoutes = routes.filter((route) => route.lazyModule === true);
  const matrixModules = lazyRoutes.map((route) => route.module).sort();
  const appModules = lazyModulesFromApp();
  const duplicateModules = matrixModules.filter(
    (moduleName, index) => matrixModules.indexOf(moduleName) !== index,
  );

  for (const moduleName of duplicateModules) {
    findings.push({
      group: "docs",
      path: rel(matrixPath),
      line: 1,
      rule: "matrix-duplicate-module",
      detail: moduleName,
    });
  }
  for (const moduleName of appModules) {
    if (!matrixModules.includes(moduleName)) {
      findings.push({
        group: "docs",
        path: rel(matrixPath),
        line: 1,
        rule: "matrix-missing-app-module",
        detail: moduleName,
      });
    }
  }
  for (const moduleName of matrixModules) {
    if (!appModules.includes(moduleName)) {
      findings.push({
        group: "docs",
        path: rel(matrixPath),
        line: 1,
        rule: "matrix-stale-module",
        detail: moduleName,
      });
    }
  }

  const requiredArrayFields = [
    "tabs",
    "dialogs",
    "drawers",
    "emptyStates",
    "criticalActions",
    "testAnchors",
    "existingTests",
    "screenshots",
  ];
  const requiredScalarFields = [
    "id",
    "module",
    "path",
    "routeKind",
    "surface",
    "testData",
    "cleanup",
    "e2eJourney",
  ];
  for (const [index, route] of routes.entries()) {
    const label = route?.id ?? `routes[${index}]`;
    for (const field of requiredScalarFields) {
      if (typeof route?.[field] !== "string" || route[field].trim() === "") {
        findings.push({
          group: "docs",
          path: rel(matrixPath),
          line: 1,
          rule: "matrix-route-field-missing",
          detail: `${label}.${field}`,
        });
      }
    }
    for (const field of requiredArrayFields) {
      if (!Array.isArray(route?.[field])) {
        findings.push({
          group: "docs",
          path: rel(matrixPath),
          line: 1,
          rule: "matrix-route-array-missing",
          detail: `${label}.${field}`,
        });
      }
    }
  }
  if (!Array.isArray(matrix.redirects) || matrix.redirects.length === 0) {
    findings.push({
      group: "docs",
      path: rel(matrixPath),
      line: 1,
      rule: "matrix-redirects-missing",
      detail: "legacy redirects must be explicit test surfaces",
    });
  }
  return findings;
}

function printSummary(label, findings) {
  const grouped = new Map();
  for (const finding of findings) {
    grouped.set(finding.group, (grouped.get(finding.group) ?? 0) + 1);
  }
  console.log(`${label}: findings=${findings.length}`);
  for (const [group, count] of [...grouped.entries()].sort()) {
    console.log(`${label}: ${group}: ${count}`);
  }
}

function printFindings(findings, limit = 300) {
  const output = verboseMode ? findings : findings.slice(0, limit);
  for (const finding of output) {
    console.log(
      `${finding.group}\t${finding.rule}\t${finding.path}:${finding.line}\t${finding.detail}`,
    );
  }
  if (!verboseMode && findings.length > limit) {
    console.log(
      `... ${findings.length - limit} additional findings hidden; rerun with --verbose`,
    );
  }
}

validateTailwindTokenMatcher();
validateAdminReductionMatchers();

const docsFindings = [...validateAdminDocs(), ...validateMatrix()];
const legacyFindings = [
  ...collectLegacyFindings(),
  ...collectAdminReductionFindings(),
];

console.log("admin-ui-facade guard");
console.log(
  `mode=${finalCheckMode ? "final-check" : docsCheckMode ? "docs-check" : "report"}`,
);
printSummary("docs", docsFindings);
printSummary("legacy", legacyFindings);

if (reportMode || docsCheckMode || finalCheckMode) {
  if (docsFindings.length > 0) {
    console.log("docs findings:");
    printFindings(docsFindings, Number.POSITIVE_INFINITY);
  }
  if (reportMode || finalCheckMode) {
    console.log("legacy findings:");
    printFindings(legacyFindings);
  }
}

if (docsCheckMode && docsFindings.length > 0) {
  console.error(
    `admin-ui-facade docs-check failed: ${docsFindings.length} documentation/matrix findings`,
  );
  process.exit(1);
}

if (finalCheckMode && docsFindings.length + legacyFindings.length > 0) {
  console.error(
    `admin-ui-facade final-check failed: ${docsFindings.length} docs findings and ${legacyFindings.length} legacy findings`,
  );
  process.exit(1);
}

if (docsCheckMode) {
  console.log("admin-ui-facade docs-check ok");
}
if (finalCheckMode) {
  console.log("admin-ui-facade final-check ok");
}
