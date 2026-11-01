// SPDX-License-Identifier: AGPL-3.0-or-later

import { gitGraphDirectiveSpans } from "./runtime-contract.js";
import { hasTerminalMermaidDirectiveEnd } from "../diagram-types.js";
import {
  gitGraphDiagnostic,
  type GitGraphDiagnosticCode,
} from "./diagnostics.js";

function gitGraphConfigurationSource(lines: readonly string[]) {
  const fragments: string[] = [];
  let index = 0;
  if (lines[0]?.trim() === "---") {
    for (; index < lines.length; index += 1) {
      fragments.push(lines[index]);
      if (index > 0 && lines[index].trim() === "---") {
        index += 1;
        break;
      }
    }
  }
  for (; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith("%%{")) continue;
    for (; index < lines.length; index += 1) {
      fragments.push(lines[index]);
      if (hasTerminalMermaidDirectiveEnd(lines[index])) break;
    }
  }
  return fragments.join("\n");
}

function decodeGitGraphConfigurationScalar(
  doubleQuoted: string | undefined,
  singleQuoted: string | undefined,
  plain: string | undefined,
) {
  if (doubleQuoted !== undefined) {
    try {
      return JSON.parse(`"${doubleQuoted}"`) as string;
    } catch {
      return doubleQuoted;
    }
  }
  if (singleQuoted !== undefined) return singleQuoted.replaceAll("''", "'");
  return (plain ?? "").replace(/\s+#.*$/, "").trim();
}

export function gitGraphMainBranchConfig(lines: readonly string[]) {
  const source = gitGraphConfigurationSource(lines);
  const names = [
    ...source.matchAll(
      /["']?mainBranchName["']?\s*:\s*(?:"((?:\\.|[^"])*)"|'((?:''|[^'])*)'|([^,}\n]+))/g,
    ),
  ];
  const orders = [
    ...source.matchAll(
      /["']?mainBranchOrder["']?\s*:\s*(-?(?:0|[1-9]\d*)(?:\.\d+)?)/g,
    ),
  ];
  const name = names.at(-1);
  const order = orders.at(-1);
  return {
    mainBranchName: name
      ? decodeGitGraphConfigurationScalar(name[1], name[2], name[3]) || "main"
      : "main",
    mainBranchOrder: order ? Number(order[1]) : 0,
  };
}

import {
  readSourceYaml,
  sourceFrontmatter,
  restoreFrontmatterPrefix,
  sourceYamlFieldPatch,
  type SourceYaml,
} from "../source-yaml.js";
import type {
  GitGraphSourceDocument,
  GitGraphRecord,
} from "./source-document.js";
export const GITGRAPH_DEFAULT_CONFIG = {
  titleTopMargin: 25,
  diagramPadding: 8,
  nodeLabel: { width: 75, height: 100, x: -25, y: 0 },
  mainBranchName: "main",
  mainBranchOrder: 0,
  showCommitLabel: true,
  showBranches: true,
  rotateCommitLabel: true,
  parallelCommits: false,
  arrowMarkerAbsolute: false,
  useMaxWidth: true,
};
export type GitGraphConfig = typeof GITGRAPH_DEFAULT_CONFIG;
export const GITGRAPH_CONFIG_EFFECT = {
  titleTopMargin: "layout",
  diagramPadding: "layout",
  nodeLabel: "stored-only",
  mainBranchName: "execution",
  mainBranchOrder: "layout",
  showCommitLabel: "label",
  showBranches: "branch",
  rotateCommitLabel: "layout",
  parallelCommits: "layout",
  arrowMarkerAbsolute: "stored-only",
  useMaxWidth: "native-svg",
} as const;
export function readGitGraphConfig(document: GitGraphSourceDocument) {
  const scopes: Array<{
    record: GitGraphRecord;
    yaml: SourceYaml;
    path: string[];
    effective: boolean;
  }> = [];
  const config: GitGraphConfig = {
    ...GITGRAPH_DEFAULT_CONFIG,
    nodeLabel: { ...GITGRAPH_DEFAULT_CONFIG.nodeLabel },
  };
  let title = "";
  const diagnostics: Array<{
    record: GitGraphRecord;
    code: GitGraphDiagnosticCode;
    message: string;
    severity: "warning" | "error";
    stage?: "render";
    reference?: string;
  }> = [];
  // Native detectInit discards the complete directive result after any JSON
  // parse failure. Frontmatter remains a separate effective config provider.
  const invalidInit = document.records
    .filter((r) => r.kind === "directive")
    .some((r) => {
      const span = gitGraphDirectiveSpans(r.raw)[0];
      if (!span || !/(?:init\b)|(?:initialize\b)/.test(span.type) || span.plain)
        return false;
      try {
        if (span.args) JSON.parse(span.args.replaceAll("'", '"'));
        return false;
      } catch {
        return true;
      }
    });
  for (const r of document.records) {
    let yaml: SourceYaml | null = null,
      path: string[] = [],
      effective = true;
    if (r.kind === "frontmatter") {
      const frontmatter = sourceFrontmatter(r.raw);
      if (frontmatter)
        yaml = readSourceYaml(
          frontmatter.body,
          r.range.start + frontmatter.start,
        );
      path = ["config", "gitGraph"];
    }
    if (r.kind === "directive") {
      const span = gitGraphDirectiveSpans(r.raw)[0];
      if (span && /(?:init\b)|(?:initialize\b)/.test(span.type)) {
        const raw = span.args,
          nativeRaw = raw.replaceAll("'", '"');
        try {
          const native: unknown = JSON.parse(nativeRaw);
          effective =
            !invalidInit &&
            !!native &&
            typeof native === "object" &&
            !Array.isArray(native);
        } catch {
          effective = false;
        }
        yaml = readSourceYaml(
          effective ? nativeRaw : raw,
          r.range.start + span.argsStart,
          { allowDuplicateKeys: true },
        );
        if (!effective)
          diagnostics.push({
            record: r,
            severity: "warning",
            code: "gitgraph.config.ignored-init",
            message: gitGraphDiagnostic("gitgraph.config.ignored-init"),
          });
      }
      path =
        yaml && Object.hasOwn(yaml.values, "config")
          ? ["config"]
          : ["gitGraph"];
    }
    if (!yaml) {
      if (r.kind === "frontmatter")
        diagnostics.push({
          record: r,
          severity: "error",
          code: "gitgraph.config.mapping",
          message: gitGraphDiagnostic("gitgraph.config.mapping"),
        });
      continue;
    }
    if (r.kind === "frontmatter" && yaml.values.title)
      title = String(yaml.values.title);
    scopes.push({ record: r, yaml, path, effective });
    if (!effective) continue;
    let values: unknown = yaml.values;
    for (const key of path)
      values =
        values && typeof values === "object"
          ? (values as Record<string, unknown>)[key]
          : undefined;
    if (!values || typeof values !== "object") continue;
    for (const key of Object.keys(config) as Array<keyof GitGraphConfig>) {
      const value = (values as Record<string, unknown>)[key];
      if (value === undefined) continue;
      if (key === "nodeLabel" && value && typeof value === "object")
        config.nodeLabel = { ...config.nodeLabel, ...value };
      // Mermaid does not validate config scalar types. Its renderer consumes
      // flags by truthiness and dimensions/orders by numeric coercion. Keep the
      // original provider in nativeConfig/CST, but expose those actual effects
      // to the editable projection rather than silently restoring defaults.
      else if (typeof config[key] === "boolean")
        Object.assign(config, { [key]: Boolean(value) });
      else if (typeof config[key] === "number")
        Object.assign(config, { [key]: Number(value) });
      else if (
        key === "mainBranchName" &&
        Array.isArray(value) &&
        value.every((row) => typeof row === "string")
      )
        config.mainBranchName = value.map((row) => row.trim()).join("\n");
      else if (typeof value === typeof config[key])
        Object.assign(config, { [key]: value });
    }
  }
  const nativeConfig: Record<string, unknown> = {};
  for (const scope of scopes.filter((s) => s.effective)) {
    let value: unknown = scope.yaml.values;
    for (const key of scope.path)
      value =
        value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    if (value && typeof value === "object") Object.assign(nativeConfig, value);
  }
  for (const key of Object.keys(config) as Array<keyof GitGraphConfig>) {
    // Native branch order is only a sort comparator: NaN compares as equal,
    // and infinities place lanes without poisoning their geometry. Title
    // margin is consumed only when the native diagram actually has a title.
    if (
      key !== "diagramPadding" &&
      !(
        key === "titleTopMargin" &&
        (title || document.records.some((r) => r.kind === "title" && r.value))
      )
    )
      continue;
    if (typeof config[key] !== "number" || Number.isFinite(config[key]))
      continue;
    const scope = scopes.findLast((s) => {
      if (!s.effective) return false;
      let value: unknown = s.yaml.values;
      for (const part of [...s.path, key])
        value =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[part]
            : undefined;
      return value !== undefined;
    });
    if (scope)
      diagnostics.push({
        record: scope.record,
        stage: "render",
        severity: "error",
        code: "gitgraph.config.non-finite",
        reference: key,
        message: gitGraphDiagnostic("gitgraph.config.non-finite", key),
      });
  }
  const main = nativeConfig.mainBranchName;
  if (
    Object.hasOwn(nativeConfig, "mainBranchName") &&
    typeof main !== "string" &&
    !(Array.isArray(main) && main.every((row) => typeof row === "string"))
  ) {
    const scope = scopes.findLast((s) => {
      if (!s.effective) return false;
      let value: unknown = s.yaml.values;
      for (const key of [...s.path, "mainBranchName"])
        value =
          value && typeof value === "object"
            ? (value as Record<string, unknown>)[key]
            : undefined;
      return value !== undefined;
    });
    if (scope)
      diagnostics.push({
        record: scope.record,
        stage: "render",
        severity: "error",
        code: "gitgraph.config.branch-label",
        reference: "mainBranchName",
        message: gitGraphDiagnostic("gitgraph.config.branch-label"),
      });
  }
  return { config, title, scopes, diagnostics, nativeConfig };
}
/** Patch the last actual Source provider. Unknown global keys retain their CST. */
export function gitGraphConfigPatch(
  document: GitGraphSourceDocument,
  field: keyof GitGraphConfig,
  value: unknown,
) {
  const read = readGitGraphConfig(document),
    scopes = read.scopes.filter((s) => s.effective);
  const scope =
    scopes.findLast((s) => {
      let v: unknown = s.yaml.values;
      for (const k of [...s.path, field])
        v =
          v && typeof v === "object"
            ? (v as Record<string, unknown>)[k]
            : undefined;
      return v !== undefined;
    }) ?? scopes.at(-1);
  if (scope)
    return gitGraphScopeFieldPatch(
      document,
      scope,
      [...scope.path, field],
      value,
    );
  const header = document.records.find((r) => r.kind === "header");
  return [
    {
      range: { start: header?.range.start ?? 0, end: header?.range.start ?? 0 },
      value: `%%{init: ${JSON.stringify({ gitGraph: { [field]: value } }).replaceAll("'", "\\u0027")}}%%${document.newline}`,
    },
  ];
}

/** Native-renderer options share Mermaid's global config owner. They do not
 * override the server-theme typography of the editable GFX projection. */
export const GITGRAPH_GLOBAL_OPTIONS = {
  theme: {
    type: "select",
    values: ["default", "base", "dark", "forest", "neutral"],
  },
  fontFamily: { type: "string" },
  fontSize: { type: "string" },
  htmlLabels: { type: "boolean" },
  look: { type: "select", values: ["classic", "handDrawn"] },
  layout: { type: "string" },
  markdownAutoWrap: { type: "boolean" },
  wrappingWidth: { type: "number" },
  handDrawnSeed: { type: "number" },
  deterministicIds: { type: "boolean" },
  deterministicIDSeed: { type: "string" },
} as const;
export type GitGraphGlobalOption = keyof typeof GITGRAPH_GLOBAL_OPTIONS;
export function readGitGraphGlobalOptions(document: GitGraphSourceDocument) {
  const options: Partial<Record<GitGraphGlobalOption, unknown>> = {};
  for (const scope of readGitGraphConfig(document).scopes.filter(
    (s) => s.effective,
  )) {
    const values =
      scope.record.kind === "frontmatter"
        ? scope.yaml.values.config
        : scope.yaml.values;
    if (!values || typeof values !== "object" || Array.isArray(values))
      continue;
    for (const key of Object.keys(
      GITGRAPH_GLOBAL_OPTIONS,
    ) as GitGraphGlobalOption[]) {
      const value = (values as Record<string, unknown>)[key];
      if (value !== undefined) options[key] = value;
    }
  }
  return options;
}
export function gitGraphGlobalOptionPatch(
  document: GitGraphSourceDocument,
  key: GitGraphGlobalOption,
  value: unknown,
) {
  const scopes = readGitGraphConfig(document).scopes.filter((s) => s.effective);
  const scope =
    scopes.findLast((s) => {
      const config =
        s.record.kind === "frontmatter" ? s.yaml.values.config : s.yaml.values;
      return (
        !!config && typeof config === "object" && Object.hasOwn(config, key)
      );
    }) ?? scopes.at(-1);
  if (scope)
    return gitGraphScopeFieldPatch(
      document,
      scope,
      scope.record.kind === "frontmatter" ? ["config", key] : [key],
      value,
    );
  const header = document.records.find((r) => r.kind === "header");
  return [
    {
      range: { start: header?.range.start ?? 0, end: header?.range.start ?? 0 },
      value: `%%{init: ${JSON.stringify({ [key]: value }).replaceAll("'", "\\u0027")}}%%${document.newline}`,
    },
  ];
}

import { stringify as stringifyYaml } from "yaml";
/** Opaque graphs may contain YAML aliases/cycles. Their secondary editor uses
 * the existing YAML codec, while no-op comparison remains graph-aware. */
export function formatGitGraphConfigValue(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return stringifyYaml(value).trimEnd();
  }
}
export function readGitGraphConfigValue(text: string) {
  const yaml = readSourceYaml(
    `value:
${text
  .split(/\r?\n/)
  .map((line) => `  ${line}`)
  .join("\n")}`,
    0,
  );
  return yaml
    ? { valid: true as const, value: yaml.values.value }
    : { valid: false as const };
}

/** Native init converts every apostrophe before JSON.parse. Escape authored
 * apostrophes in changed JSON values; retained directive bytes stay untouched. */
export function gitGraphScopeFieldPatch(
  document: GitGraphSourceDocument,
  scope: ReturnType<typeof readGitGraphConfig>["scopes"][number],
  path: readonly string[],
  value: unknown,
) {
  const patches = sourceYamlFieldPatch(scope.yaml, path, value);
  if (patches && scope.record.kind === "frontmatter") {
    const prefix = sourceFrontmatter(scope.record.raw)?.prefix ?? "";
    return patches.map((p) => ({
      ...p,
      value: restoreFrontmatterPrefix(p.value, prefix),
    }));
  }
  if (!patches || scope.record.kind !== "directive") return patches;
  return patches.map((p) => {
    let text = p.value.replaceAll("'", "\\u0027");
    const raw = document.source.slice(p.range.start, p.range.end);
    if (
      raw.startsWith("'") &&
      raw.endsWith("'") &&
      text.startsWith('"') &&
      text.endsWith('"')
    )
      text = "'" + text.slice(1, -1) + "'";
    return { ...p, value: text };
  });
}
