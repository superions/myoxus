// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const selfTest = args.has("--self-test");
const modeArg = process.argv.find((arg) => arg.startsWith("--mode="));
const mode = modeArg?.slice("--mode=".length) || "both";

const roots = [
  {
    path: "client/libs/ui-facade/src",
    owner: "facade",
    category: "facade-foundation",
  },
  {
    path: "client/admin/workspaces/admin/src",
    owner: "admin",
    category: "admin-product",
  },
  {
    path: "client/libs/core/src",
    owner: "web-core",
    category: "web-core-product",
  },
  {
    path: "client/web/workspaces/web/src",
    owner: "web-core",
    category: "web-core-product",
  },
  {
    path: "client/libs/theme/src",
    owner: "theme",
    category: "theme-projection",
  },
  {
    path: "client/branding",
    owner: "theme",
    category: "theme-projection",
  },
];

const variableRoots = [
  {
    path: "client",
    owner: "client",
    category: "client-source",
  },
  {
    path: "virgultum",
    owner: "editor",
    category: "renderer-source",
  },
  {
    path: "server",
    owner: "server",
    category: "server-renderers",
  },
  {
    path: "build/scripts",
    owner: "tooling",
    category: "tooling",
  },
];

const ignoredSegments = new Set([
  ".git",
  ".yarn",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "test-results",
]);

const sourceFilePattern = /\.(?:css|mjs|js|jsx|ts|tsx)$/;
const variableSourceFilePattern = /\.(?:css|html|json|mjs|js|jsx|rs|ts|tsx)$/;
const variableInventoryScript =
  "build/scripts/ci/report-frontend-css-typography-inventory.mjs";
const generatedVariableArtifacts = new Set([
  "client/branding/theme-fallback.css",
]);
const cssFilePattern = /\.(?:css)$/;
const productTypographyProps =
  /\b(?:fontSize|fontWeight|fontFamily|lineHeight|letterSpacing|textTransform|textDecoration)\s*:/g;
const mantineTypographyProps = /\b(?:fz|fw|ff|lh|lts|td|tt)=/g;
const cssTypographyDeclarations =
  /\b(?:font(?:-family|-size|-style|-weight)?|line-height|letter-spacing|text-transform|text-decoration)\s*:/g;
const cssColorDeclarations =
  /\b(?:color|background|background-color|border-color|outline-color|box-shadow|text-shadow)\s*:/g;
const rawColorLiterals =
  /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|\b(?:white|black|transparent)\b/gi;
const radiusDeclarations = /\bborder-radius\s*:/g;
const shadowDeclarations = /\bbox-shadow\s*:/g;
const spacingDeclarations =
  /\b(?:gap|row-gap|column-gap|padding(?:-[a-z]+)?|margin(?:-[a-z]+)?)\s*:/g;
const zIndexDeclarations = /\bz-index\s*:/g;
const importantDeclarations = /!important\b/g;
const selectorPattern = /(^|})\s*([^@{}][^{}]*)\{/g;
const declarationPattern = /[a-z-]+\s*:\s*[^;{}]+;/gi;
const inlineStylePattern = /\bstyle=\{\{/g;
const routeSpecificSelectorPattern =
  /\.(?:admin|web|workspace|settings|sidebar|menu|card|table|dialog|panel|toolbar)[a-z0-9_-]*/gi;

function countMatches(source, pattern) {
  return [...source.matchAll(pattern)].length;
}

function listFiles(root) {
  const absoluteRoot = path.join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const files = [];
  const walk = (absolutePath) => {
    for (const entry of readdirSync(absolutePath)) {
      if (ignoredSegments.has(entry)) continue;
      const child = path.join(absolutePath, entry);
      const stat = statSync(child, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        walk(child);
      } else if (sourceFilePattern.test(entry)) {
        files.push(path.relative(repoRoot, child));
      }
    }
  };
  walk(absoluteRoot);
  return files.sort();
}

function listVariableFiles(root) {
  const absoluteRoot = path.join(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const files = [];
  const walk = (absolutePath) => {
    for (const entry of readdirSync(absolutePath)) {
      if (ignoredSegments.has(entry)) continue;
      const child = path.join(absolutePath, entry);
      const stat = statSync(child, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        walk(child);
      } else if (variableSourceFilePattern.test(entry)) {
        files.push(path.relative(repoRoot, child));
      }
    }
  };
  walk(absoluteRoot);
  return files.sort();
}

function classifyFile(file) {
  const root =
    roots.find((candidate) => file.startsWith(`${candidate.path}/`)) ??
    roots.find((candidate) => file === candidate.path);
  const isTest =
    /\.spec\.[jt]sx?$/.test(file) ||
    file.includes("/__tests__/") ||
    file.includes("/fixtures/");
  if (isTest) {
    return {
      owner: root?.owner ?? "test",
      category: "test-fixture",
    };
  }
  if (file === "client/libs/ui-facade/src/provider.tsx") {
    return {
      owner: "facade",
      category: "theme-projection",
    };
  }
  return {
    owner: root?.owner ?? "unknown",
    category: root?.category ?? "invalid",
  };
}

function analyzeFile(file, source) {
  const isCss = cssFilePattern.test(file);
  const classification = classifyFile(file);
  const counters = {};

  if ((mode === "both" || mode === "css") && isCss) {
    counters.cssFiles = 1;
    counters.selectors = countMatches(source, selectorPattern);
    counters.declarations = countMatches(source, declarationPattern);
    counters.colorDeclarations = countMatches(source, cssColorDeclarations);
    counters.rawColorLiterals = countMatches(source, rawColorLiterals);
    counters.radiusDeclarations = countMatches(source, radiusDeclarations);
    counters.shadowDeclarations = countMatches(source, shadowDeclarations);
    counters.spacingDeclarations = countMatches(source, spacingDeclarations);
    counters.zIndexDeclarations = countMatches(source, zIndexDeclarations);
    counters.importantDeclarations = countMatches(
      source,
      importantDeclarations,
    );
    counters.routeSpecificSelectors = countMatches(
      source,
      routeSpecificSelectorPattern,
    );
  }

  if (mode === "both" || mode === "typography") {
    counters.typographyDeclarations = countMatches(
      source,
      cssTypographyDeclarations,
    );
    counters.inlineStyleBlocks = countMatches(source, inlineStylePattern);
    counters.inlineTypographyProps = countMatches(
      source,
      productTypographyProps,
    );
    counters.rawMantineTypographyProps = countMatches(
      source,
      mantineTypographyProps,
    );
  }

  const nonZeroCounters = Object.fromEntries(
    Object.entries(counters).filter(([, value]) => value > 0),
  );

  if (Object.keys(nonZeroCounters).length === 0) return null;

  return {
    file,
    ...classification,
    counters: nonZeroCounters,
  };
}

function collectRecords() {
  return roots
    .flatMap((root) => listFiles(root.path))
    .map((file) =>
      analyzeFile(file, readFileSync(path.join(repoRoot, file), "utf8")),
    )
    .filter(Boolean)
    .sort((a, b) => a.file.localeCompare(b.file));
}

function summarize(records) {
  const byCategory = new Map();
  const byOwner = new Map();
  const totals = {};

  for (const record of records) {
    const category = byCategory.get(record.category) ?? {};
    const owner = byOwner.get(record.owner) ?? {};
    for (const [counter, value] of Object.entries(record.counters)) {
      totals[counter] = (totals[counter] ?? 0) + value;
      category[counter] = (category[counter] ?? 0) + value;
      owner[counter] = (owner[counter] ?? 0) + value;
    }
    byCategory.set(record.category, category);
    byOwner.set(record.owner, owner);
  }

  return {
    totals,
    byOwner: Object.fromEntries([...byOwner.entries()].sort()),
    byCategory: Object.fromEntries([...byCategory.entries()].sort()),
  };
}

function isVariableTestFile(file) {
  return (
    file.includes("/__tests__/") ||
    file.includes("/fixtures/") ||
    file.includes("/test/") ||
    file.includes("/tests/") ||
    /\.(?:spec|test)\.[jt]sx?$/.test(file) ||
    /_test\.rs$/.test(file)
  );
}

function stripVariableComments(source, file) {
  const withoutComments = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return file.endsWith(".rs")
    ? withoutComments.replace(/#\[cfg\(test\)\][\s\S]*$/g, "")
    : withoutComments;
}

function camelToKebab(value) {
  return value
    .replaceAll("-", "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z])(?=[a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/(\D+)(\d+)$/g, "$1-$2")
    .replace(/[\s_]/g, "-");
}

function themeVariableName(key) {
  return key.startsWith("--") ? key : `--myoxus-${camelToKebab(key)}`;
}

function webVariableName(key) {
  return key.startsWith("--")
    ? key
    : `--myoxus-web-${key.replace(/[/.]/g, "-")}`;
}

function addVariableLocation(records, name, file) {
  const record = records.get(name) ?? {
    count: 0,
    files: new Set(),
    countsByFile: new Map(),
  };
  record.count += 1;
  record.files.add(file);
  record.countsByFile.set(file, (record.countsByFile.get(file) ?? 0) + 1);
  records.set(name, record);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dynamicTemplatePattern(template, transform = (value) => value) {
  const marker = "MYOXUS_DYNAMIC_VALUE";
  const marked = template.replace(/\$\{[^}]+\}/g, marker);
  const transformed = transform(marked);
  const source = escapeRegExp(transformed).replaceAll(marker, "[a-zA-Z0-9_-]+");
  return `^${source}$`;
}

function isSpecificDynamicPattern(pattern) {
  const staticPart = pattern
    .replace(/^\^|\$$/g, "")
    .replaceAll("[a-zA-Z0-9_-]+", "")
    .replaceAll("\\", "");
  return (
    staticPart.replaceAll("-", "").length > 0 &&
    !["--", "--myoxus-", "--myoxus-web-"].includes(staticPart)
  );
}

function classifyVariableFile(file) {
  const root = variableRoots.find(
    (candidate) =>
      file === candidate.path || file.startsWith(`${candidate.path}/`),
  );
  return {
    owner: root?.owner ?? "unknown",
    category: root?.category ?? "unknown",
  };
}

function variablePrefix(name) {
  if (name.startsWith("--mantine-")) return "--mantine-*";
  if (name.startsWith("--myoxus-sem-")) return "--myoxus-sem-*";
  if (name.startsWith("--myoxus-typography-")) {
    return "--myoxus-typography-*";
  }
  if (name.startsWith("--myoxus-web-")) return "--myoxus-web-*";
  if (name.startsWith("--myoxus-")) return "--myoxus-*";
  return "other";
}

function incrementGroup(groups, key, field, amount = 1) {
  const record = groups.get(key) ?? {
    uniqueNames: new Set(),
    definitionCount: 0,
    consumerCount: 0,
    deadNames: new Set(),
  };
  if (field === "uniqueNames") {
    record.uniqueNames.add(amount);
  } else if (field === "deadDefinitions") {
    record.deadNames.add(amount);
  } else {
    record[field] += amount;
  }
  groups.set(key, record);
}

function serializeGroups(groups) {
  return Object.fromEntries(
    [...groups.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, record]) => [
        key,
        {
          uniqueNames: record.uniqueNames.size,
          definitionCount: record.definitionCount,
          consumerCount: record.consumerCount,
          deadDefinitions: record.deadNames.size,
        },
      ]),
  );
}

function findEnclosingCallableName(source, offset) {
  const prefix = source.slice(Math.max(0, offset - 900), offset);
  const matches = [
    ...prefix.matchAll(
      /(?:function\s+|(?:private|protected|public)\s+)?([a-zA-Z_$][\w$]*)\s*\([^)]*\)\s*(?::[^={]+)?\s*\{/g,
    ),
  ];
  return matches.at(-1)?.[1] ?? null;
}

function addResolvedDynamicPropertyConsumers({
  source,
  file,
  addConsumer,
  addDynamicPattern,
}) {
  const propertyReadPattern =
    /\.getPropertyValue\(\s*`([^`]*\$\{([a-zA-Z_$][\w$]*)\}[^`]*)`/g;
  for (const match of source.matchAll(propertyReadPattern)) {
    const [template, parameter] = match.slice(1);
    const callableName = findEnclosingCallableName(source, match.index);
    if (!callableName) {
      addDynamicPattern(dynamicTemplatePattern(template), file);
      continue;
    }
    const literalCallPattern = new RegExp(
      "\\b" + escapeRegExp(callableName) + "\\(\\s*[\"'`]([^\"'`$]+)[\"'`]",
      "g",
    );
    let resolved = false;
    for (const call of source.matchAll(literalCallPattern)) {
      addConsumer(template.replace(`\${${parameter}}`, call[1]), file);
      resolved = true;
    }
    if (!resolved) {
      addDynamicPattern(dynamicTemplatePattern(template), file);
    }
  }
}

function collectVariableInventory() {
  const definitions = new Map();
  const consumers = new Map();
  const dynamicPatterns = new Map();
  const files = variableRoots
    .flatMap((root) => listVariableFiles(root.path))
    .filter((file, index, all) => all.indexOf(file) === index)
    // The inventory's own parser fixtures describe variable families; they
    // are not runtime consumers and must not inflate the audited source count.
    .filter((file) => file !== variableInventoryScript)
    // Generated Electron output has its own full-catalog drift/uniqueness gate.
    // Counting all 16 materialized projections as source declarations would
    // hide whether authored runtime layers were actually reduced.
    .filter((file) => !generatedVariableArtifacts.has(file))
    .filter((file) => !isVariableTestFile(file));

  const addDynamicPattern = (pattern, file) => {
    if (!isSpecificDynamicPattern(pattern)) return;
    const record = dynamicPatterns.get(pattern) ?? new Set();
    record.add(file);
    dynamicPatterns.set(pattern, record);
  };
  const addConsumer = (name, file) => {
    addVariableLocation(consumers, name, file);
  };

  for (const file of files) {
    const source = stripVariableComments(
      readFileSync(path.join(repoRoot, file), "utf8"),
      file,
    );
    const definitionOffsets = new Set();
    const isProjectionProducer =
      file === "server/crates/infrastructure/src/branding/mod.rs" ||
      file === "build/scripts/branding/export-client-theme-fallback.mjs";

    for (const match of source.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)) {
      if (file.endsWith(".rs") && !match[1].startsWith("--myoxus-")) {
        continue;
      }
      addVariableLocation(definitions, match[1], file);
      definitionOffsets.add(match.index);
    }
    for (const match of source.matchAll(
      /\.setProperty\(\s*["'`](--[a-zA-Z0-9_-]+)["'`]/g,
    )) {
      addVariableLocation(definitions, match[1], file);
      definitionOffsets.add(match.index + match[0].indexOf(match[1]));
    }

    if (isProjectionProducer) {
      for (const match of source.matchAll(/--myoxus-[a-zA-Z0-9_-]+/g)) {
        addVariableLocation(definitions, match[0], file);
        definitionOffsets.add(match.index);
      }
    }

    for (const match of source.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)) {
      addConsumer(match[1], file);
    }
    for (const match of source.matchAll(
      /\.getPropertyValue\(\s*["'`](--[a-zA-Z0-9_-]+)["'`]/g,
    )) {
      addConsumer(match[1], file);
    }

    const literalCalls = [
      {
        pattern: /\b(?:cssWebVar|unsafeCSSWebVar)\(\s*["'`]([^"'`$]+)["'`]/g,
        variableName: webVariableName,
      },
      {
        pattern: /\b(?:cssVar|unsafeCSSVar)\(\s*["'`]([^"'`$]+)["'`]/g,
        variableName: themeVariableName,
      },
    ];
    for (const { pattern, variableName } of literalCalls) {
      for (const match of source.matchAll(pattern)) {
        addConsumer(variableName(match[1]), file);
      }
    }
    for (const match of source.matchAll(
      /\bcssTypographyVar\(\s*["'`]([^"'`$]+)["'`]\s*,\s*["'`]([^"'`$]+)["'`]/g,
    )) {
      addConsumer(`--myoxus-typography-${match[1]}-${match[2]}`, file);
    }

    for (const match of source.matchAll(
      /var\(\s*(--[a-zA-Z0-9_-]*(?:\$\{[^}]+\}[a-zA-Z0-9_-]*)+)/g,
    )) {
      addDynamicPattern(dynamicTemplatePattern(match[1]), file);
    }
    for (const match of source.matchAll(
      /\b(cssWebVar|unsafeCSSWebVar|cssVar|unsafeCSSVar)\(\s*`([^`]*\$\{[^`]*)`/g,
    )) {
      const [, helper, template] = match;
      const transform = helper.includes("Web")
        ? webVariableName
        : themeVariableName;
      addDynamicPattern(dynamicTemplatePattern(template, transform), file);
    }
    addResolvedDynamicPropertyConsumers({
      source,
      file,
      addConsumer,
      addDynamicPattern,
    });

    if (!isProjectionProducer) {
      for (const match of source.matchAll(/--[a-zA-Z0-9_-]+/g)) {
        if (
          definitionOffsets.has(match.index) ||
          source.slice(match.index + match[0].length).startsWith("${")
        ) {
          continue;
        }
        addConsumer(match[0], file);
      }
    }
  }

  const dynamicEntries = [...dynamicPatterns.entries()].map(
    ([pattern, patternFiles]) => ({
      pattern,
      files: [...patternFiles].sort(),
      regex: new RegExp(pattern),
    }),
  );
  const protectedContract = (name) =>
    name.startsWith("--mantine-") ||
    name.startsWith("--myoxus-sem-") ||
    name.startsWith("--myoxus-typography-") ||
    name === "--myoxus-background-code-block";

  const names = new Set([...definitions.keys(), ...consumers.keys()]);
  const variables = [...names].sort().map((name) => {
    const definition = definitions.get(name);
    const consumer = consumers.get(name);
    const dynamicConsumers = dynamicEntries.filter(({ regex }) =>
      regex.test(name),
    );
    const protectedName = protectedContract(name);
    const dead =
      Boolean(definition) &&
      !consumer &&
      dynamicConsumers.length === 0 &&
      !protectedName;
    return {
      name,
      definitionCount: definition?.count ?? 0,
      definitionFiles: [...(definition?.files ?? [])].sort(),
      consumerCount: consumer?.count ?? 0,
      consumerFiles: [...(consumer?.files ?? [])].sort(),
      dynamicConsumerPatterns: dynamicConsumers.map(({ pattern }) => pattern),
      protectedContract: protectedName,
      dead,
    };
  });

  const byPrefix = new Map();
  const byProducer = new Map();
  const byConsumerOwner = new Map();
  for (const variable of variables) {
    const prefix = variablePrefix(variable.name);
    incrementGroup(byPrefix, prefix, "uniqueNames", variable.name);
    incrementGroup(
      byPrefix,
      prefix,
      "definitionCount",
      variable.definitionCount,
    );
    incrementGroup(byPrefix, prefix, "consumerCount", variable.consumerCount);
    if (variable.dead) {
      incrementGroup(byPrefix, prefix, "deadDefinitions", variable.name);
    }

    for (const file of variable.definitionFiles) {
      const owner = classifyVariableFile(file).owner;
      incrementGroup(byProducer, owner, "uniqueNames", variable.name);
      incrementGroup(
        byProducer,
        owner,
        "definitionCount",
        definitions.get(variable.name)?.countsByFile.get(file) ?? 0,
      );
      if (variable.dead) {
        incrementGroup(byProducer, owner, "deadDefinitions", variable.name);
      }
    }
    for (const file of variable.consumerFiles) {
      const owner = classifyVariableFile(file).owner;
      incrementGroup(byConsumerOwner, owner, "uniqueNames", variable.name);
      incrementGroup(
        byConsumerOwner,
        owner,
        "consumerCount",
        consumers.get(variable.name)?.countsByFile.get(file) ?? 0,
      );
    }
  }

  return {
    roots: variableRoots,
    filesScanned: files.length,
    summary: {
      uniqueNames: variables.length,
      uniqueDefinitions: variables.filter(({ definitionCount }) =>
        Boolean(definitionCount),
      ).length,
      declarationCount: variables.reduce(
        (total, variable) => total + variable.definitionCount,
        0,
      ),
      uniqueConsumers: variables.filter(({ consumerCount }) =>
        Boolean(consumerCount),
      ).length,
      consumerCount: variables.reduce(
        (total, variable) => total + variable.consumerCount,
        0,
      ),
      deadDefinitions: variables.filter(({ dead }) => dead).length,
      protectedDefinitions: variables.filter(
        ({ definitionCount, protectedContract }) =>
          definitionCount > 0 && protectedContract,
      ).length,
      dynamicPatterns: dynamicEntries.length,
    },
    dynamicPatterns: dynamicEntries.map(({ pattern, files: patternFiles }) => ({
      pattern,
      files: patternFiles,
    })),
    groups: {
      byPrefix: serializeGroups(byPrefix),
      byProducer: serializeGroups(byProducer),
      byConsumerOwner: serializeGroups(byConsumerOwner),
    },
    variables,
  };
}

function printVariableInventory(inventory) {
  console.log("# frontend custom-property inventory");
  console.log("mode=variables");
  console.log(`filesScanned=${inventory.filesScanned}`);
  console.log("");
  console.log("## summary");
  for (const [counter, value] of Object.entries(inventory.summary).sort()) {
    console.log(`${counter}: ${value}`);
  }
  for (const [groupName, groups] of Object.entries(inventory.groups)) {
    console.log("");
    console.log(`## ${groupName}`);
    for (const [name, record] of Object.entries(groups)) {
      console.log(
        `${name}\tunique=${record.uniqueNames}\tdefinitions=${record.definitionCount}\tconsumers=${record.consumerCount}\tdead=${record.deadDefinitions}`,
      );
    }
  }
  console.log("");
  console.log("## dead definitions");
  for (const variable of inventory.variables.filter(({ dead }) => dead)) {
    console.log(
      `${variable.name}\tdefinitions=${variable.definitionCount}\tfiles=${variable.definitionFiles.join(",")}`,
    );
  }
  console.log("");
  console.log("## dynamic consumer patterns");
  for (const pattern of inventory.dynamicPatterns) {
    console.log(`${pattern.pattern}\tfiles=${pattern.files.join(",")}`);
  }
}

function printText(records, summary) {
  console.log(`# frontend css/typography inventory`);
  console.log(`mode=${mode}`);
  console.log(`records=${records.length}`);
  console.log("");
  console.log("## summary");
  for (const [counter, value] of Object.entries(summary.totals).sort()) {
    console.log(`${counter}: ${value}`);
  }
  console.log("");
  console.log("## records");
  for (const record of records) {
    const counters = Object.entries(record.counters)
      .sort()
      .map(([key, value]) => `${key}=${value}`)
      .join(" ");
    console.log(
      `${record.file}\towner=${record.owner}\tcategory=${record.category}\t${counters}`,
    );
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runSelfTest() {
  if (mode !== "variables") {
    const admin = analyzeFile(
      "client/admin/workspaces/admin/src/example.tsx",
      'export function Example(){return <div style={{ fontSize: "12px" }} />}',
    );
    assert(admin.owner === "admin", "admin owner classification failed");
    assert(admin.category === "admin-product", "admin category failed");
    assert(
      admin.counters.inlineTypographyProps === 1,
      "inline typography counter failed",
    );

    const css = analyzeFile(
      "client/libs/core/src/example.css",
      ".workspace-card { color: #fff; border-radius: 4px; font-size: 12px; }",
    );
    assert(css.owner === "web-core", "web-core owner classification failed");
    assert(css.counters.cssFiles === 1, "css file counter failed");
    assert(css.counters.rawColorLiterals >= 1, "raw color counter failed");
    assert(
      css.counters.routeSpecificSelectors === 1,
      "selector counter failed",
    );

    const provider = analyzeFile(
      "client/libs/ui-facade/src/provider.tsx",
      "export const theme = createTheme({ fontFamily: cssTypographyVar('body', 'family') });",
    );
    assert(
      provider.category === "theme-projection",
      "provider category failed",
    );
  }

  assert(
    themeVariableName("overlayPanelShadow") === "--myoxus-overlay-panel-shadow",
    "theme variable mapping failed",
  );
  assert(
    webVariableName("control-height/md") === "--myoxus-web-control-height-md",
    "Web variable mapping failed",
  );
  assert(
    new RegExp(dynamicTemplatePattern("--myoxus-tag-${color}")).test(
      "--myoxus-tag-blue",
    ),
    "dynamic variable pattern failed",
  );
  assert(
    !isSpecificDynamicPattern(dynamicTemplatePattern("--myoxus-${name}")),
    "broad Myoxus prefix must not protect declaration-only names",
  );
  assert(
    isSpecificDynamicPattern(
      dynamicTemplatePattern("--myoxus-text-highlight-${color}"),
    ),
    "bounded dynamic family must remain discoverable",
  );

  const resolvedConsumers = new Map();
  const resolvedPatterns = [];
  addResolvedDynamicPropertyConsumers({
    source: `function webToken(name) {
      return getComputedStyle(document.body).getPropertyValue(\`--myoxus-web-\${name}\`);
    }
    webToken("space-4");`,
    file: "self-test.ts",
    addConsumer: (name, file) =>
      addVariableLocation(resolvedConsumers, name, file),
    addDynamicPattern: (pattern) => resolvedPatterns.push(pattern),
  });
  assert(
    resolvedConsumers.has("--myoxus-web-space-4"),
    "literal dynamic property call must resolve to an exact consumer",
  );
  assert(
    resolvedPatterns.length === 0,
    "resolved dynamic property call must not retain a broad family",
  );

  console.log("frontend css/typography inventory self-test passed");
}

function assertNoRetiredVersionedThemeApi() {
  const fragments = [
    ["--myoxus", "v2-"].join("-"),
    ["cssVar", "V2"].join(""),
    ["unsafeCSSVar", "V2"].join(""),
    ["lightTheme", "V2"].join(""),
    ["darkTheme", "V2"].join(""),
    ["AffineThemeKey", "V2"].join(""),
    ["themeToVar", "V2"].join(""),
    ["lightCssVariables", "V2"].join(""),
    ["darkCssVariables", "V2"].join(""),
  ];
  const retiredPackageExport = new RegExp(
    `${["@myoxus/theme", "v2"].join("/")}["']`,
  );
  const findings = [];
  for (const root of [
    ...variableRoots.map(({ path: rootPath }) => rootPath),
    "tests",
  ]) {
    for (const file of listFiles(root)) {
      if (
        file === variableInventoryScript ||
        file.startsWith("client/libs/theme/src/v2/themes/")
      ) {
        continue;
      }
      const source = readFileSync(path.join(repoRoot, file), "utf8");
      for (const fragment of fragments) {
        if (source.includes(fragment)) {
          findings.push(`${file}: ${fragment}`);
        }
      }
      if (retiredPackageExport.test(source)) {
        findings.push(`${file}: retired package export`);
      }
    }
  }
  assert(
    findings.length === 0,
    `retired versioned theme API must remain absent:\n${findings
      .slice(0, 40)
      .join("\n")}`,
  );
}

function assertThemeProjectionOwnership(inventory) {
  const liveProducer = "server/crates/infrastructure/src/branding/mod.rs";
  const electronProducer =
    "build/scripts/branding/export-client-theme-fallback.mjs";
  const baseTheme = "client/libs/theme/src/style.css";
  const retiredBridge = path.join(
    repoRoot,
    "client/branding/runtime-theme.css",
  );

  assert(
    !existsSync(retiredBridge),
    "client/branding/runtime-theme.css is a retired duplicate projection layer",
  );
  assert(
    inventory.summary.deadDefinitions === 0,
    `custom-property inventory has ${inventory.summary.deadDefinitions} dead definitions`,
  );

  const variablesFor = (file) =>
    new Set(
      inventory.variables
        .filter(({ definitionFiles }) => definitionFiles.includes(file))
        .map(({ name }) => name),
    );
  const liveVariables = variablesFor(liveProducer);
  const electronVariables = variablesFor(electronProducer);
  const liveOnly = [...liveVariables].filter(
    (name) => !electronVariables.has(name),
  );
  const electronOnly = [...electronVariables].filter(
    (name) => !liveVariables.has(name),
  );
  assert(
    liveOnly.length === 0 && electronOnly.length === 0,
    `live and Electron projections diverge:\nserver-only=${liveOnly.join(",")}\nelectron-only=${electronOnly.join(",")}`,
  );

  const baseConflicts = inventory.variables.filter(
    ({ definitionFiles }) =>
      definitionFiles.includes(baseTheme) &&
      (definitionFiles.includes(liveProducer) ||
        definitionFiles.includes(electronProducer)),
  );
  assert(
    baseConflicts.length === 0,
    `base theme duplicates runtime projection variables:\n${baseConflicts
      .map(({ name }) => name)
      .join("\n")}`,
  );

  for (const loader of [
    "client/web/workspaces/web/src/runtime-theme.ts",
    "client/admin/workspaces/admin/src/runtime-theme.ts",
  ]) {
    const source = readFileSync(path.join(repoRoot, loader), "utf8");
    assert(
      !source.includes("theme-fallback"),
      `${loader} must not consume the Electron-only fallback`,
    );
  }
  const electronLoader = readFileSync(
    path.join(
      repoRoot,
      "client/apps/electron-renderer/src/app/runtime-theme.ts",
    ),
    "utf8",
  );
  assert(
    electronLoader.includes("getThemeFallbackHref"),
    "Electron runtime loader must retain the full-catalog offline fallback",
  );
}

if (!["both", "css", "typography", "variables"].includes(mode)) {
  console.error(
    `invalid --mode=${mode}; expected both, css, typography or variables`,
  );
  process.exit(2);
}

if (selfTest) {
  runSelfTest();
} else {
  assertNoRetiredVersionedThemeApi();
}

if (!selfTest && mode === "variables") {
  const inventory = collectVariableInventory();
  assertThemeProjectionOwnership(inventory);
  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode,
          ...inventory,
        },
        null,
        2,
      ),
    );
  } else {
    printVariableInventory(inventory);
  }
} else if (!selfTest) {
  const records = collectRecords();
  const summary = summarize(records);
  if (json) {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          mode,
          roots,
          summary,
          records,
        },
        null,
        2,
      ),
    );
  } else {
    printText(records, summary);
  }
}
