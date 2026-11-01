// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel, MermaidGitDirection } from "../model.js";
import {
  gitGraphDocument,
  gitGraphRecord,
  writeGitGraphPatches,
  gitGraphInsertPatch,
  type GitGraphInsertAnchor,
  type GitGraphPatch,
} from "../writer.js";
import { gitGraphConfigPatch, type GitGraphConfig } from "../config.js";
import { editGitGraphBranch } from "./branch-commands.js";
import { rejectGitGraphCommand } from "./commit-commands.js";
export function editGitGraphConfig(
  model: MermaidGitGraphModel,
  values: Partial<GitGraphConfig>,
  direction?: MermaidGitDirection,
) {
  const document = gitGraphDocument(model),
    patches: GitGraphPatch[] = [];
  // Apply CST changes successively while advancing bindings; one GUI commit
  // receives only the final candidate and the union of semantic impact.
  let current = model;
  const impact: import("../writer.js").GitGraphImpact[] = [];
  const metadata = { ...values };
  if (
    metadata.mainBranchName !== undefined ||
    metadata.mainBranchOrder !== undefined
  ) {
    const header = document.records.find((r) => r.kind === "header")!;
    const result = editGitGraphBranch(current, header.sourceKey, {
      name: metadata.mainBranchName,
      order: metadata.mainBranchOrder,
    });
    if (result.status === "rejected") return result;
    impact.push(...result.impact);
    current = result.model;
    delete metadata.mainBranchName;
    delete metadata.mainBranchOrder;
  }
  for (const [field, value] of Object.entries(metadata)) {
    const p = gitGraphConfigPatch(
      gitGraphDocument(current),
      field as keyof GitGraphConfig,
      value,
    );
    if (!p) return rejectGitGraphCommand(model, "gitgraph.config.patch");
    const result = writeGitGraphPatches(
      current,
      p.map((p) => ({ start: p.range.start, end: p.range.end, text: p.value })),
    );
    if (result.status === "rejected")
      return { ...result, source: document.source, model };
    impact.push(...result.impact);
    current = result.model;
  }
  if (direction) {
    const h = gitGraphDocument(current).records.find(
      (r) => r.kind === "header",
    )!;
    const text = h.raw.replace(/\b(?:LR|TB|BT)\b/, direction);
    patches.push({
      start: h.range.start,
      end: h.range.end,
      text:
        text === h.raw && !/\b(?:LR|TB|BT)\b/.test(h.raw)
          ? `${h.indent}gitGraph ${direction}:`
          : text,
    });
  }
  const result = writeGitGraphPatches(current, patches);
  return {
    ...result,
    impact: [...impact, ...result.impact],
    changed: result.source !== document.source,
    status:
      result.status === "rejected"
        ? ("rejected" as const)
        : result.source === document.source
          ? ("unchanged" as const)
          : ("changed" as const),
  };
}
export function editGitGraphAccessibility(
  model: MermaidGitGraphModel,
  title: string,
  description: string,
) {
  const doc = gitGraphDocument(model),
    patches: GitGraphPatch[] = [];
  if (
    /[\r\n]/.test(title) ||
    (/[\r\n]/.test(description) && description.includes("}"))
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.accessibility.value",
      gitGraphDocument(model).records.find(
        (r) =>
          r.kind === "accessibility-title" ||
          r.kind === "accessibility-description",
      )?.sourceKey,
    );
  for (const [kind, value] of [
    ["accessibility-title", title],
    ["accessibility-description", description],
  ] as const) {
    const record = doc.records.findLast((r) => r.kind === kind);
    if (record?.value === value || (!record && !value)) continue;
    if (record) {
      if (
        record.valueRange &&
        !/[\r\n]/.test(value) &&
        !/^[ \t]*accDescr[ \t]*\{/.test(record.raw)
      )
        patches.push({
          start: record.valueRange.start,
          end: record.valueRange.end,
          text: value,
        });
      else
        patches.push({
          start: record.range.start,
          end: record.range.end,
          text: `${record.indent}${kind === "accessibility-title" ? `accTitle: ${value}` : !/[\r\n]/.test(value) && value.includes("}") ? `accDescr: ${value}` : `accDescr {${doc.newline}${value}${doc.newline}}`}`,
        });
    } else {
      const h = doc.records.find((r) => r.kind === "header")!;
      const insertion = gitGraphInsertPatch(
        model,
        { sourceKey: h.sourceKey, position: "after" },
        [
          kind === "accessibility-title"
            ? `accTitle: ${value}`
            : !/[\r\n]/.test(value) && value.includes("}")
              ? `accDescr: ${value}`
              : `accDescr {${doc.newline}${value}${doc.newline}}`,
        ],
      );
      patches.push(insertion.patch);
    }
  }
  return writeGitGraphPatches(model, patches);
}
export function editGitGraphComment(
  model: MermaidGitGraphModel,
  key: string | null,
  text: string,
  anchor?: GitGraphInsertAnchor,
) {
  if (/[\r\n]/.test(text))
    return rejectGitGraphCommand(
      model,
      "gitgraph.comment.line",
      key ?? anchor?.sourceKey ?? undefined,
    );
  if (!key) {
    const p = gitGraphInsertPatch(
      model,
      anchor ?? { sourceKey: null, position: "after" },
      [`%% ${text}`],
    );
    return writeGitGraphPatches(model, [p.patch], p.selection);
  }
  const r = gitGraphRecord(model, key);
  if (r.kind !== "comment")
    return rejectGitGraphCommand(model, "gitgraph.comment.selection", key);
  if (r.value === text && !anchor) return writeGitGraphPatches(model, [], key);
  if (anchor) {
    const document = gitGraphDocument(model),
      at = gitGraphInsertPatch(model, anchor, []).patch.start;
    if (at >= r.range.start && at <= r.range.end + r.eol.length)
      return writeGitGraphPatches(
        model,
        r.value === text
          ? []
          : [
              {
                start: r.range.start,
                end: r.range.end,
                text: `${r.indent}%% ${text}`,
              },
            ],
        key,
      );
    // Moving to EOF must create a new record even without a trailing newline.
    // Keep the original comment lexeme and advance its identity past that separator.
    const separator =
      at > 0 && !/[\r\n]$/.test(document.source.slice(0, at))
        ? document.newline
        : "";
    return writeGitGraphPatches(
      model,
      [
        { start: r.range.start, end: r.range.end + r.eol.length, text: "" },
        {
          start: at,
          end: at,
          text: `${separator}${r.value === text ? r.raw : `${r.indent}%% ${text}`}${document.newline}`,
          identities: [[separator.length, key]],
        },
      ],
      key,
    );
  }
  return writeGitGraphPatches(
    model,
    [{ start: r.range.start, end: r.range.end, text: `${r.indent}%% ${text}` }],
    key,
  );
}

import {
  gitGraphScopeFieldPatch,
  gitGraphGlobalOptionPatch,
  type GitGraphGlobalOption,
  readGitGraphConfig,
} from "../config.js";
/** Only an explicitly selected opaque config key enters this secondary editor.
 * A CST leaf patch leaves adjacent known controls and foreign metadata intact. */
export function editGitGraphGlobalConfig(
  model: MermaidGitGraphModel,
  recordKey: string,
  path: readonly string[],
  value: unknown,
) {
  const scope = readGitGraphConfig(gitGraphDocument(model)).scopes.find(
    (s) => s.record.sourceKey === recordKey,
  );
  if (
    !scope ||
    !path.length ||
    path.some((p) => ["__proto__", "constructor", "prototype"].includes(p))
  )
    return rejectGitGraphCommand(model, "gitgraph.config.owner", recordKey);
  const patches = gitGraphScopeFieldPatch(
    gitGraphDocument(model),
    scope,
    path,
    value,
  );
  if (!patches)
    return rejectGitGraphCommand(model, "gitgraph.config.patch", recordKey);
  return writeGitGraphPatches(
    model,
    patches.map((p) => ({
      start: p.range.start,
      end: p.range.end,
      text: p.value,
    })),
    recordKey,
  );
}

export function editGitGraphGlobalOption(
  model: MermaidGitGraphModel,
  key: GitGraphGlobalOption,
  value: unknown,
) {
  const patches = gitGraphGlobalOptionPatch(
    gitGraphDocument(model),
    key,
    value,
  );
  return patches
    ? writeGitGraphPatches(
        model,
        patches.map((p) => ({
          start: p.range.start,
          end: p.range.end,
          text: p.value,
        })),
      )
    : rejectGitGraphCommand(model, "gitgraph.config.patch");
}
