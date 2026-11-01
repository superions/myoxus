// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGitGraphModel } from "../model.js";

import {
  gitGraphRecord,
  gitGraphDocument,
  gitGraphAttributePatch,
  gitGraphBranchTargetPatches,
  type GitGraphBranchTarget,
  gitGraphSetAttributePatch,
  gitGraphInsertPatch,
  gitGraphTagPatches,
  type GitGraphTagEdit,
  writeGitGraphPatches,
  type GitGraphInsertAnchor,
  type GitGraphPatch,
  type GitGraphCommandResult,
} from "../writer.js";
import {
  gitGraphDiagnostic,
  type GitGraphDiagnosticCode,
} from "../diagnostics.js";
import { encodeGitString } from "../runtime-contract.js";
import {
  gitGraphAttribute,
  gitGraphRuntimeText,
  gitGraphSanitizeNativeValue,
} from "../derived-graph.js";

/** Suggest an authored ID without changing occurrence bindings. The checked
 * command still validates collisions and the current Source basis. */
export function nextGitGraphExplicitCommitId(model: MermaidGitGraphModel) {
  let i = 1;
  let id: string;
  do {
    id = `commit-${i++}`;
  } while (model.derivedGraph?.effectiveMap.has(id));
  return id;
}

export function addGitGraphCommit(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  values: {
    id: string;
    message: string;
    type: import("../model.js").MermaidGitSourceCommitType;
    tags: readonly string[];
  },
) {
  const id = values.id || nextGitGraphExplicitCommitId(model);
  if (
    model.derivedGraph?.effectiveMap.has(
      gitGraphRuntimeText(id, model.derivedGraph?.sanitization),
    )
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.id.unique",
      anchor.sourceKey ?? undefined,
    );
  const statement = `commit id:${encodeGitString(id)}${values.message ? ` msg:${encodeGitString(values.message)}` : ""} type:${values.type}${values.tags.map((t) => ` tag:${encodeGitString(t)}`).join("")}`;
  const inserted = gitGraphInsertPatch(model, anchor, [statement]);
  return writeGitGraphPatches(model, [inserted.patch], inserted.selection);
}
export function rejectGitGraphCommand(
  model: MermaidGitGraphModel,
  code: GitGraphDiagnosticCode,
  sourceKey?: string,
): GitGraphCommandResult {
  const document = gitGraphDocument(model),
    r =
      document.records.find((r) => r.sourceKey === sourceKey) ??
      document.records.find((r) => r.kind === "header") ??
      document.records[0];
  return {
    status: "rejected" as const,
    changed: false,
    source: document.source,
    model,
    impact: [],
    diagnostics: [
      {
        stage: "runtime" as const,
        severity: "error" as const,
        code,
        sourceKey: r?.sourceKey ?? "",
        range: r?.range ?? { start: 0, end: 0, line: 1 },
        message: gitGraphDiagnostic(code),
      },
    ],
  };
}
/** ID references resolve at each statement, not against the final effective map.
 * Only references to the edited occurrence participate in this atomic rename. */
export function editGitGraphCommit(
  model: MermaidGitGraphModel,
  key: string,
  values: {
    id?: string | null;
    message?: string | null;
    type?: import("../model.js").MermaidGitSourceCommitType | null;
    tags?: readonly (string | GitGraphTagEdit)[];
    branchTarget?: GitGraphBranchTarget;
  },
) {
  const r = gitGraphRecord(model, key),
    patches: GitGraphPatch[] = [];
  if (
    (values.message !== undefined && r.kind !== "commit") ||
    (values.type !== undefined && r.kind === "cherry-pick") ||
    (values.id !== undefined && r.kind === "cherry-pick")
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.generated.attribute",
      r.sourceKey,
    );
  if (
    values.branchTarget !== undefined &&
    model.branches.find((b) => b.sourceKey === values.branchTarget!.sourceKey)
      ?.referenceable === false
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.branch.reference",
      values.branchTarget.sourceKey,
    );
  if (values.branchTarget !== undefined && r.reference)
    patches.push(...gitGraphBranchTargetPatches(model, r, values.branchTarget));
  if (values.id !== undefined) {
    const current = gitGraphAttribute(r, "id"),
      next = values.id ?? "";
    if (current !== next) {
      const candidate = gitGraphRuntimeText(
        next,
        model.derivedGraph?.sanitization,
      );
      if (
        candidate &&
        model.derivedGraph?.occurrences.some(
          (c) => c.sourceKey !== key && c.runtimeId === candidate,
        )
      )
        return rejectGitGraphCommand(model, "gitgraph.id.unique", r.sourceKey);
      patches.push(...gitGraphSetAttributePatch(r, "id", values.id));
      const map = new Map<string, string>();
      for (const record of gitGraphDocument(model).records) {
        if (record.kind === "cherry-pick")
          for (const a of record.attributes.filter(
            (a) => a.name === "id" || a.name === "parent",
          ))
            if (
              map.get(
                gitGraphSanitizeNativeValue(
                  a.nativeValue ?? a.value,
                  model.derivedGraph?.sanitization,
                ),
              ) === key
            ) {
              if (!next)
                return rejectGitGraphCommand(
                  model,
                  "gitgraph.id.referenced",
                  r.sourceKey,
                );
              patches.push(gitGraphAttributePatch(a, next));
            }
        const occurrence = model.derivedGraph?.occurrences.find(
          (c) => c.sourceKey === record.sourceKey,
        );
        if (occurrence) map.set(occurrence.runtimeId, record.sourceKey);
      }
    }
  }
  if (values.message !== undefined)
    patches.push(...gitGraphSetAttributePatch(r, "message", values.message));
  if (values.type !== undefined)
    patches.push(...gitGraphSetAttributePatch(r, "type", values.type));
  if (values.tags !== undefined)
    patches.push(...gitGraphTagPatches(r, values.tags));
  return writeGitGraphPatches(model, patches, key);
}

/** A shadowed scalar remains a real independently editable Source occurrence. */
export function editGitGraphAttributeOccurrence(
  model: MermaidGitGraphModel,
  recordKey: string,
  attributeKey: string,
  value: string | null,
) {
  const r = gitGraphRecord(model, recordKey),
    a = r.attributes.find((a) => a.sourceKey === attributeKey);
  if (!a)
    return rejectGitGraphCommand(
      model,
      "gitgraph.attribute.missing",
      recordKey,
    );
  if (a.value === value) return writeGitGraphPatches(model, [], recordKey);
  if (
    a.name === "id" &&
    a.effective &&
    r.kind !== "cherry-pick" &&
    value !== null
  )
    return editGitGraphCommit(model, recordKey, { id: value });
  if (
    a.name === "id" &&
    a.effective &&
    r.kind !== "cherry-pick" &&
    value === null
  ) {
    const previous = r.attributes
      .filter((t) => t.name === "id" && t !== a)
      .at(-1);
    const renamed = editGitGraphCommit(model, recordKey, {
      id: previous?.value ?? null,
    });
    if (renamed.status === "rejected") return renamed;
    const provider = gitGraphRecord(renamed.model, recordKey).attributes.find(
      (t) => t.sourceKey === attributeKey,
    );
    const result = provider
      ? writeGitGraphPatches(
          renamed.model,
          [{ start: provider.range.start, end: provider.range.end, text: "" }],
          recordKey,
        )
      : renamed;
    if (result.status === "rejected")
      return { ...result, source: gitGraphDocument(model).source, model };
    const changed = result.source !== gitGraphDocument(model).source;
    return {
      ...result,
      changed,
      status: changed ? "changed" : "unchanged",
      impact: [...renamed.impact, ...result.impact],
    };
  }
  return writeGitGraphPatches(
    model,
    [
      value === null
        ? { start: a.range.start, end: a.range.end, text: "" }
        : gitGraphAttributePatch(a, value),
    ],
    recordKey,
  );
}

export function editGitGraphBulkTags(
  model: MermaidGitGraphModel,
  keys: readonly string[],
  values: readonly string[],
  mode: "add" | "replace",
) {
  const records = keys.map((key) => gitGraphRecord(model, key));
  if (
    !records.length ||
    records.some((r) => !["commit", "merge", "cherry-pick"].includes(r.kind))
  )
    return rejectGitGraphCommand(model, "gitgraph.selection.tags", keys[0]);
  const patches = records.flatMap((r) =>
    gitGraphTagPatches(r, [
      ...(mode === "add"
        ? r.attributes
            .filter((a) => a.name === "tag")
            .map((a) => ({ sourceKey: a.sourceKey, value: a.value }))
        : []),
      ...values.map((value) => ({ value })),
    ]),
  );
  return writeGitGraphPatches(model, patches, keys[0]);
}
