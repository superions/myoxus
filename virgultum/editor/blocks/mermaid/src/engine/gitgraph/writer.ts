// SPDX-License-Identifier: AGPL-3.0-or-later

import { gitGraphBranchName, type MermaidGitGraphModel } from "./model.js";
import { generateMermaidCommonMetadataLines } from "../common-metadata.js";
import { gitGraphMainBranchConfig } from "./config.js";

export function referenceSource(value: string) {
  return /^\w(?:[-./\w]*[-\w])?$/.test(value) ? value : quotedGitString(value);
}

export function attributeSource(key: string, value: string) {
  return ` ${key}:${quotedGitString(value)}`;
}

export function quotedGitString(value: string) {
  let quoted = '"';
  for (const char of value) {
    if (char === "\\") quoted += "\\\\";
    else if (char === '"') quoted += '\\"';
    else if (char === "\b") quoted += "\\b";
    else if (char === "\f") quoted += "\\f";
    else if (char === "\n") quoted += "\\n";
    else if (char === "\r") quoted += "\\r";
    else if (char === "\t") quoted += "\\t";
    else if (char === "\v") quoted += "\\v";
    else if (char.codePointAt(0) === 0) quoted += "\\0";
    else quoted += char;
  }
  return `${quoted}"`;
}

/** Full generation is restricted to initial model-only creation. Existing Source
 * documents retain every occurrence and are changed through checked patches. */
export function generateMermaidGitGraphSource(model: MermaidGitGraphModel) {
  if (model.sourceDocument) return model.sourceDocument.source;
  const header =
    model.explicitDirection || model.direction !== "LR"
      ? `gitGraph ${model.direction}:`
      : model.headerLine === "gitGraph:" || model.headerLine === "gitGraph :"
        ? model.headerLine
        : "gitGraph";
  const configuredMainBranch = gitGraphMainBranchConfig(model.directives);
  const configurationOverride =
    configuredMainBranch.mainBranchName === model.mainBranchName &&
    configuredMainBranch.mainBranchOrder === model.mainBranchOrder
      ? []
      : [
          `%%{init: ${JSON.stringify({
            gitGraph: {
              mainBranchName: model.mainBranchName,
              mainBranchOrder: model.mainBranchOrder,
            },
          })}}%%`,
        ];
  const lines = [
    ...model.directives.filter((line) => line.trim()),
    ...configurationOverride,
    header,
    ...generateMermaidCommonMetadataLines(model),
  ];
  const commitById = new Map(
    model.commits.map((commit) => [commit.id, commit]),
  );
  for (const event of [...model.events].sort((a, b) => a.order - b.order)) {
    if (event.kind === "branch") {
      lines.push(
        `  branch ${referenceSource(event.targetBranchId)}${
          event.branchOrder === null ? "" : ` order: ${event.branchOrder}`
        }`,
      );
      continue;
    }
    if (event.kind === "checkout") {
      lines.push(`  ${event.keyword} ${referenceSource(event.targetBranchId)}`);
      continue;
    }
    if (event.kind === "merge") {
      let statement = `  merge ${referenceSource(event.targetBranchId)}`;
      if (event.customId) statement += attributeSource("id", event.customId);
      for (const tag of event.tags) statement += attributeSource("tag", tag);
      if (event.type) statement += ` type: ${event.type}`;
      lines.push(statement);
      continue;
    }
    if (event.kind === "cherry-pick") {
      let statement = `  cherry-pick${attributeSource("id", event.sourceCommitId)}`;
      for (const tag of event.tags) statement += attributeSource("tag", tag);
      if (event.parentCommitId) {
        statement += attributeSource("parent", event.parentCommitId);
      }
      lines.push(statement);
      continue;
    }
    const commit = commitById.get(event.commitId);
    if (!commit) continue;
    let statement = "  commit";
    if (commit.sourceId) statement += attributeSource("id", commit.sourceId);
    if (commit.message) statement += attributeSource("msg", commit.message);
    for (const tag of commit.tags) statement += attributeSource("tag", tag);
    if (commit.typeExplicit) statement += ` type: ${commit.type}`;
    lines.push(statement);
  }
  lines.push(...model.sourceAnnotations.filter((line) => line.trim()));
  return `${lines.join("\n")}\n`;
}

import type { GitGraphAttribute, GitGraphRecord } from "./source-document.js";
import { nextGitGraphSourceKey } from "./source-document.js";
import { resolveMermaidGitGraphSource } from "./parser.js";
import {
  encodeGitString,
  editGitString,
  encodeGitReference,
  gitGraphNativeStringValue,
} from "./runtime-contract.js";
import type { GitGraphDiagnostic } from "./diagnostics.js";
export type GitGraphPatch = {
  start: number;
  end: number;
  text: string;
  identities?: readonly (readonly [number, string])[];
  attributeIdentities?: readonly (readonly [number, string])[];
};
export type GitGraphImpact = {
  sourceKey: string;
  beforeBranch: string;
  beforeBranchLabel: string;
  beforeHead: string | null;
  beforeParents: string[];
  beforeHeadLabel: string;
  beforeParentLabels: string[];
  beforeReferences: string[];
} & (
  | {
      /** Native execution stops here; no later heads or parents may be invented. */
      blockedByLine: number;
    }
  | {
      afterBranch: string;
      afterBranchLabel: string;
      afterHead: string | null;
      afterParents: string[];
      afterHeadLabel: string;
      afterParentLabels: string[];
      afterReferences: string[];
    }
);
export type GitGraphCommandResult = {
  status: "changed" | "unchanged" | "rejected";
  changed: boolean;
  source: string;
  model: MermaidGitGraphModel;
  diagnostics: GitGraphDiagnostic[];
  /** Rejected candidates keep saved Source intact; diagnostic ranges use this candidate. */
  diagnosticSource?: string;
  impact: GitGraphImpact[];
  selection?: string;
};
export function gitGraphDocument(model: MermaidGitGraphModel) {
  if (!model.sourceDocument)
    throw new Error("GitGraph edits require the current Source document.");
  return model.sourceDocument;
}
/** Original-basis patches and advanced record bindings are one checked result.
 * The GUI applies this result once, never rewrites against a gesture snapshot. */
export function writeGitGraphPatches(
  model: MermaidGitGraphModel,
  patches: readonly GitGraphPatch[],
  selection?: string,
): GitGraphCommandResult {
  const document = gitGraphDocument(model),
    ordered = [...patches].sort((a, b) => a.start - b.start || a.end - b.end);
  let last = 0;
  for (const p of ordered) {
    if (
      !Number.isInteger(p.start) ||
      !Number.isInteger(p.end) ||
      p.start < last ||
      p.end < p.start ||
      p.end > document.source.length
    )
      throw new Error("Invalid or overlapping GitGraph source patches.");
    last = p.end;
  }
  let source = document.source;
  for (const p of [...ordered].reverse())
    source = source.slice(0, p.start) + p.text + source.slice(p.end);
  if (source === document.source)
    return {
      status: "unchanged",
      changed: false,
      source,
      model,
      diagnostics: [],
      impact: [],
      selection,
    };
  const mapping = new Map<number, string>();
  for (const r of document.records) {
    const covered = ordered.find(
      (p) => p.start <= r.range.start && r.range.start < p.end,
    );
    if (covered && (!covered.text || covered.start !== r.range.start)) continue;
    const delta = ordered
      .filter(
        (p) =>
          p.end <= r.range.start &&
          (p.start < r.range.start || p.start === p.end),
      )
      .reduce((sum, p) => sum + p.text.length - (p.end - p.start), 0);
    mapping.set(r.range.start + delta, r.sourceKey);
  }
  const attributeMapping = new Map<number, string>();
  for (const r of document.records)
    for (const a of r.attributes) {
      const covered = ordered.find(
        (p) => p.start <= a.range.start && a.range.start < p.end,
      );
      if (covered && (!covered.text || covered.start !== a.range.start))
        continue;
      const delta = ordered
        .filter(
          (p) =>
            p.end <= a.range.start &&
            (p.start < a.range.start || p.start === p.end),
        )
        .reduce((sum, p) => sum + p.text.length - (p.end - p.start), 0);
      attributeMapping.set(a.range.start + delta, a.sourceKey);
    }
  let delta = 0;
  for (const p of ordered) {
    for (const [offset, key] of p.identities ?? [])
      mapping.set(p.start + delta + offset, key);
    for (const [offset, key] of p.attributeIdentities ?? [])
      attributeMapping.set(p.start + delta + offset, key);
    delta += p.text.length - (p.end - p.start);
  }
  const resolved = resolveMermaidGitGraphSource(source, {
    previous: document,
    mapping,
    attributeMapping,
  });
  const impact: GitGraphImpact[] = [];
  const executionError = resolved.diagnostics.find(
    (d) => d.stage === "runtime" && d.severity === "error",
  );
  const label = (key: string | null, m: MermaidGitGraphModel) => {
    const c = m.derivedGraph?.occurrences.find((c) => c.sourceKey === key),
      r = m.sourceDocument?.records.find((r) => r.sourceKey === key);
    return c?.sourceId || (c ? `${c.kind} · ${r?.range.line ?? ""}` : "∅");
  };
  const references = (key: string, m: MermaidGitGraphModel) => {
    const r = m.sourceDocument?.records.find((r) => r.sourceKey === key);
    return r
      ? [
          ...(r.reference ? [r.reference.value] : []),
          ...r.attributes
            .filter((a) => a.effective && ["id", "parent"].includes(a.name))
            .map((a) => `${a.name}:${a.value}`),
        ]
      : [];
  };
  for (const c of model.derivedGraph?.contexts ?? []) {
    const after = resolved.graph.contexts.find(
      (n) => n.sourceKey === c.sourceKey,
    );
    const candidateRecord = resolved.document.records.find(
      (r) => r.sourceKey === c.sourceKey,
    );
    if (
      executionError &&
      candidateRecord &&
      ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
        candidateRecord.kind,
      ) &&
      (candidateRecord.sourceKey === executionError.sourceKey ||
        candidateRecord.range.start > executionError.range.start)
    ) {
      const beforeParents =
        model.derivedGraph?.occurrences.find((n) => n.sourceKey === c.sourceKey)
          ?.executionParents ?? [];
      impact.push({
        sourceKey: c.sourceKey,
        beforeBranch: c.branch,
        beforeBranchLabel: gitGraphBranchName(model, c.branch),
        beforeHead: c.head,
        beforeHeadLabel: label(c.head, model),
        beforeParents,
        beforeParentLabels: beforeParents.map((k) => label(k, model)),
        beforeReferences: references(c.sourceKey, model),
        blockedByLine: executionError.range.line,
      });
      continue;
    }
    if (!after) continue;
    const beforeParents =
        model.derivedGraph?.occurrences.find((n) => n.sourceKey === c.sourceKey)
          ?.executionParents ?? [],
      afterParents =
        resolved.graph.occurrences.find((n) => n.sourceKey === c.sourceKey)
          ?.executionParents ?? [];
    const beforeReferences = references(c.sourceKey, model),
      afterReferences = resolved.currentModel
        ? references(c.sourceKey, resolved.currentModel)
        : [];
    if (
      beforeReferences.join("\0") !== afterReferences.join("\0") ||
      c.branch !== after.branch ||
      c.head !== after.head ||
      beforeParents.join("\0") !== afterParents.join("\0")
    )
      impact.push({
        sourceKey: c.sourceKey,
        beforeBranch: c.branch,
        afterBranch: after.branch,
        beforeBranchLabel: gitGraphBranchName(model, c.branch),
        afterBranchLabel: resolved.currentModel
          ? gitGraphBranchName(resolved.currentModel, after.branch)
          : "",
        beforeHead: c.head,
        afterHead: after.head,
        beforeParents,
        afterParents,
        beforeHeadLabel: label(c.head, model),
        afterHeadLabel: resolved.currentModel
          ? label(after.head, resolved.currentModel)
          : "∅",
        beforeParentLabels: beforeParents.map((k) => label(k, model)),
        afterParentLabels: resolved.currentModel
          ? afterParents.map((k) => label(k, resolved.currentModel!))
          : [],
        beforeReferences,
        afterReferences,
      });
  }
  const rejected =
    !resolved.model || resolved.diagnostics.some((d) => d.severity === "error");
  return {
    status: rejected ? "rejected" : "changed",
    changed: !rejected,
    source: rejected ? document.source : source,
    model: rejected ? model : resolved.model!,
    diagnostics: resolved.diagnostics,
    diagnosticSource: rejected ? source : undefined,
    impact,
    selection,
  };
}
export function gitGraphRecord(model: MermaidGitGraphModel, key: string) {
  const record = gitGraphDocument(model).records.find(
    (r) => r.sourceKey === key,
  );
  if (!record)
    throw new Error("The GitGraph Source occurrence no longer exists.");
  return record;
}
export function gitGraphAttributePatch(
  attribute: GitGraphAttribute,
  value: string,
): GitGraphPatch {
  const raw = attribute.raw.slice(
      attribute.valueRange.start - attribute.range.start,
    ),
    quoted = /^["']/.test(raw);
  return {
    start: attribute.valueRange.start,
    end: attribute.valueRange.end,
    text:
      value === attribute.value
        ? raw
        : attribute.name === "type" || attribute.name === "order"
          ? value
          : quoted
            ? editGitString(raw, value)
            : encodeGitString(value),
  };
}
export function gitGraphReferencePatch(
  record: GitGraphRecord,
  value: string,
): GitGraphPatch {
  if (!record.reference)
    throw new Error("This statement has no branch reference.");
  return {
    start: record.reference.range.start,
    end: record.reference.range.end,
    text:
      value === record.reference.value
        ? record.reference.raw
        : /^["']/.test(record.reference.raw)
          ? editGitString(record.reference.raw, value)
          : encodeGitReference(
              value,
              /^["']/.test(record.reference.raw),
              record.reference.raw[0] === "'" ? "'" : '"',
            ),
  };
}
export function gitGraphSetAttributePatch(
  record: GitGraphRecord,
  name: string,
  value: string | null,
): GitGraphPatch[] {
  const provider = record.attributes.findLast((a) => a.name === name);
  if (value === null)
    return record.attributes
      .filter((a) => a.name === name)
      .map((a) => ({ start: a.range.start, end: a.range.end, text: "" }));
  if (provider)
    return provider.value === value
      ? []
      : [gitGraphAttributePatch(provider, value)];
  const end = record.range.end;
  return [
    {
      start: end,
      end,
      text: ` ${name === "message" ? "msg" : name}:${name === "type" || name === "order" ? value : encodeGitString(value)}`,
    },
  ];
}
export type GitGraphInsertAnchor = {
  sourceKey: string | null;
  position: "before" | "after";
};
export function gitGraphInsertPatch(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  statements: readonly string[],
) {
  const document = gitGraphDocument(model),
    r = anchor.sourceKey ? gitGraphRecord(model, anchor.sourceKey) : null;
  const before = r
    ? document.records.filter(
        (c) =>
          c.anchor?.sourceKey === r.sourceKey && c.anchor.position === "before",
      )
    : [];
  const inline = r
    ? document.records.find(
        (c) =>
          c.anchor?.sourceKey === r.sourceKey && c.anchor.position === "inline",
      )
    : undefined;
  const at = r
    ? anchor.position === "before"
      ? Math.min(r.range.start, ...before.map((c) => c.range.start))
      : inline
        ? inline.range.end + inline.eol.length
        : r.range.end + r.eol.length
    : document.source.length;
  const separator =
    at > 0 && !/[\r\n]$/.test(document.source.slice(0, at))
      ? document.newline
      : "";
  const indent =
    r &&
    ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(r.kind)
      ? r.indent
      : "  ";
  const identities: Array<readonly [number, string]> = [];
  let text = separator;
  for (const statement of statements) {
    identities.push([text.length, nextGitGraphSourceKey()]);
    text += indent + statement + document.newline;
  }
  return {
    patch: { start: at, end: at, text, identities },
    selection: identities[0]?.[1],
  };
}

/** Context at the explicit insertion site, including the ID map at that moment. */
export function gitGraphContextAtAnchor(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
) {
  const document = gitGraphDocument(model),
    record = anchor.sourceKey ? gitGraphRecord(model, anchor.sourceKey) : null;
  const next =
    record && anchor.position === "after"
      ? document.records.find(
          (r) => r.range.start >= record.range.end + record.eol.length,
        )
      : record;
  return next
    ? model.derivedGraph?.contexts.find((c) => c.sourceKey === next.sourceKey)
    : model.derivedGraph?.finalContext;
}

export type GitGraphTagEdit = { sourceKey?: string; value: string };
/** Move tag lexemes and their identities together. Scalars between tag slots and
 * whitespace outside each slot stay untouched; equal/empty tags are distinct. */
export function gitGraphTagPatches(
  record: GitGraphRecord,
  values: readonly (string | GitGraphTagEdit)[],
): GitGraphPatch[] {
  const tags = record.attributes.filter((a) => a.name === "tag");
  const used = new Set<string>();
  const edits = values.map((v, i) => {
    const item =
      typeof v === "string" ? { value: v, sourceKey: tags[i]?.sourceKey } : v;
    const original = item.sourceKey
      ? tags.find((t) => t.sourceKey === item.sourceKey)
      : undefined;
    if (item.sourceKey && (!original || used.has(item.sourceKey)))
      throw new Error("Invalid tag occurrence binding.");
    if (item.sourceKey) used.add(item.sourceKey);
    const raw = original
      ? (() => {
          const p = gitGraphAttributePatch(original, item.value);
          const start = p.start - original.range.start,
            end = p.end - original.range.start;
          return (
            original.raw.slice(0, start) + p.text + original.raw.slice(end)
          );
        })()
      : `tag:${encodeGitString(item.value)}`;
    return { raw, key: original?.sourceKey ?? nextGitGraphSourceKey() };
  });
  const patches: GitGraphPatch[] = [];
  for (const [i, tag] of tags.entries()) {
    const item = edits[i];
    if (!item)
      patches.push({ start: tag.range.start, end: tag.range.end, text: "" });
    else if (item.raw !== tag.raw || item.key !== tag.sourceKey)
      patches.push({
        start: tag.range.start,
        end: tag.range.end,
        text: item.raw,
        attributeIdentities: [[0, item.key]],
      });
  }
  if (edits.length > tags.length) {
    let text = "";
    const attributeIdentities: Array<readonly [number, string]> = [];
    for (const item of edits.slice(tags.length)) {
      text += " ";
      attributeIdentities.push([text.length, item.key]);
      text += item.raw;
    }
    patches.push({
      start: record.range.end,
      end: record.range.end,
      text,
      attributeIdentities,
    });
  }
  return patches;
}

export type GitGraphBranchTarget = { sourceKey: string };
/** Pickers address declarations, not mutable/sanitized names. Existing quoted
 * references retain their native lexeme when used by a new sequence call. */
export function gitGraphBranchReference(
  model: MermaidGitGraphModel,
  target: GitGraphBranchTarget,
) {
  const record = gitGraphRecord(model, target.sourceKey);
  if (record.kind === "header") {
    if (model.branches[0]?.referenceable === false)
      throw new Error(
        "The native main branch has no string Source reference. Rename it first.",
      );
    return encodeGitReference(model.mainBranchName);
  }
  if (record.kind !== "branch" || !record.reference)
    throw new Error("Choose the branch declaration.");
  return record.reference.nativeLexeme ?? record.reference.raw;
}
export function gitGraphCommitReference(
  model: MermaidGitGraphModel,
  key: string,
) {
  const record = gitGraphRecord(model, key),
    attribute = record.attributes.findLast((a) => a.name === "id");
  if (!attribute || !["commit", "merge"].includes(record.kind))
    throw new Error("Choose an explicit source ID occurrence.");
  return (
    attribute.nativeLexeme ??
    gitGraphDocument(model).source.slice(
      attribute.valueRange.start,
      attribute.valueRange.end,
    )
  );
}

/** A selected Source reference retains its own quote/escape form. */
export function gitGraphAttributeLexemePatch(
  record: GitGraphRecord,
  name: "id" | "parent",
  lexeme: string,
): GitGraphPatch[] {
  const a = record.attributes.findLast((a) => a.name === name);
  if (a && (a.nativeValue ?? a.value) === gitGraphNativeStringValue(lexeme))
    return [];
  if (a)
    lexeme = gitGraphRequoteLexeme(
      lexeme,
      a.raw[a.valueRange.start - a.range.start],
    );
  return a
    ? [{ start: a.valueRange.start, end: a.valueRange.end, text: lexeme }]
    : [
        {
          start: record.range.end,
          end: record.range.end,
          text: ` ${name}:${lexeme}`,
        },
      ];
}

function gitGraphRequoteLexeme(lexeme: string, quote: string | undefined) {
  if (quote !== "'" && quote !== '"') return lexeme;
  const previous = lexeme[0];
  if (previous !== "'" && previous !== '"')
    return encodeGitString(lexeme, quote);
  if (previous === quote) return lexeme;
  let value = quote;
  for (let i = 1; i < lexeme.length - 1; i++) {
    const char = lexeme[i]!;
    if (char === "\\") {
      const next = lexeme[++i]!;
      value +=
        next === previous ? (next === quote ? "\\" + next : next) : "\\" + next;
    } else value += char === quote ? "\\" + char : char;
  }
  return value + quote;
}
export function gitGraphBranchTargetPatches(
  model: MermaidGitGraphModel,
  record: GitGraphRecord,
  target: GitGraphBranchTarget,
): GitGraphPatch[] {
  if (!record.reference) throw new Error("Choose a branch reference.");
  const branch = model.branches.find((b) => b.sourceKey === target.sourceKey);
  if (!branch) throw new Error("The branch declaration no longer exists.");
  if (
    gitGraphReferenceRuntimeValue(record, model.derivedGraph?.sanitization) ===
    branch.id
  )
    return [];
  return [
    {
      start: record.reference.range.start,
      end: record.reference.range.end,
      text: gitGraphRequoteLexeme(
        gitGraphBranchReference(model, target),
        record.reference.raw[0],
      ),
    },
  ];
}
import { gitGraphReferenceRuntimeValue } from "./derived-graph.js";
