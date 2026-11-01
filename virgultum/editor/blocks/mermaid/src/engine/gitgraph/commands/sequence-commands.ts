// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../model.js";
import {
  gitGraphDocument,
  gitGraphRecord,
  gitGraphInsertPatch,
  writeGitGraphPatches,
  gitGraphAttributeLexemePatch,
  gitGraphCommitReference,
  gitGraphBranchReference,
  type GitGraphInsertAnchor,
  type GitGraphPatch,
} from "../writer.js";
import { rejectGitGraphCommand } from "./commit-commands.js";
import {
  gitGraphSanitizeNativeValue,
  gitGraphReferenceRuntimeValue,
} from "../derived-graph.js";

export function moveGitGraphStatements(
  model: MermaidGitGraphModel,
  keys: readonly string[],
  anchor: GitGraphInsertAnchor,
) {
  const document = gitGraphDocument(model),
    records = keys
      .map((k) => gitGraphRecord(model, k))
      .sort((a, b) => a.range.start - b.range.start);
  if (
    !records.length ||
    records.some(
      (r) =>
        !["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
          r.kind,
        ),
    ) ||
    (anchor.sourceKey && keys.includes(anchor.sourceKey))
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.statement.selection",
      keys[0],
    );
  const selected = new Set(keys),
    first = records[0]!,
    last = records.at(-1)!;
  if (
    document.records.some(
      (r) =>
        r.range.start >= first.range.start &&
        r.range.start <= last.range.start &&
        ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
          r.kind,
        ) &&
        !selected.has(r.sourceKey),
    )
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.sequence.contiguous",
      keys[0],
    );
  const owned = document.records.filter(
      (r) =>
        selected.has(r.sourceKey) ||
        (r.anchor && selected.has(r.anchor.sourceKey)),
    ),
    start = Math.min(...owned.map((r) => r.range.start)),
    end = Math.max(...owned.map((r) => r.range.end + r.eol.length));
  const at = gitGraphInsertPatch(model, anchor, []).patch.start;
  if (at >= start && at <= end) return writeGitGraphPatches(model, [], keys[0]);
  let text = document.source.slice(start, end);
  if (!/[\r\n]$/.test(text)) text += document.newline;
  const prefix =
    at > 0 && !/[\r\n]$/.test(document.source.slice(0, at))
      ? document.newline
      : "";
  return writeGitGraphPatches(
    model,
    [
      { start, end, text: "" },
      {
        start: at,
        end: at,
        text: prefix + text,
        attributeIdentities: document.records
          .filter((r) => r.range.start >= start && r.range.start < end)
          .flatMap((r) =>
            r.attributes.map(
              (a) =>
                [prefix.length + a.range.start - start, a.sourceKey] as const,
            ),
          ),
        identities: document.records
          .filter((r) => r.range.start >= start && r.range.start < end)
          .map(
            (r) =>
              [prefix.length + r.range.start - start, r.sourceKey] as const,
          ),
      },
    ],
    records[0]?.sourceKey,
  );
}
export function gitGraphDeleteKeys(
  model: MermaidGitGraphModel,
  keys: readonly string[],
  strategy: "only" | "dependants",
) {
  const selected = new Set(keys),
    document = gitGraphDocument(model);
  if (strategy === "dependants") {
    const deletedBranches = new Set(
      document.records
        .filter((r) => selected.has(r.sourceKey) && r.kind === "branch")
        .map((r) =>
          gitGraphReferenceRuntimeValue(r, model.derivedGraph?.sanitization),
        ),
    );
    let added = true;
    while (added) {
      added = false;
      for (const r of document.records) {
        if (selected.has(r.sourceKey)) continue;
        const c = model.derivedGraph?.occurrences.find(
            (c) => c.sourceKey === r.sourceKey,
          ),
          ctx = model.derivedGraph?.contexts.find(
            (c) => c.sourceKey === r.sourceKey,
          );
        if (
          c?.executionParents.some((k) => selected.has(k)) ||
          (ctx &&
            deletedBranches.has(ctx.branch) &&
            ["commit", "branch", "merge", "cherry-pick"].includes(r.kind)) ||
          (r.reference &&
            deletedBranches.has(
              gitGraphReferenceRuntimeValue(
                r,
                model.derivedGraph?.sanitization,
              ),
            ))
        ) {
          selected.add(r.sourceKey);
          if (r.kind === "branch")
            deletedBranches.add(
              gitGraphReferenceRuntimeValue(
                r,
                model.derivedGraph?.sanitization,
              ),
            );
          added = true;
        }
      }
    }
  }
  for (const r of document.records)
    if (
      (r.kind === "comment" || r.kind === "blank") &&
      r.anchor &&
      selected.has(r.anchor.sourceKey)
    )
      selected.add(r.sourceKey);
  return selected;
}
export function deleteGitGraphStatements(
  model: MermaidGitGraphModel,
  keys: readonly string[],
  strategy: "only" | "dependants" | "reassign" = "only",
  target?: { branchKey?: string; commitKey?: string },
) {
  const document = gitGraphDocument(model),
    selected = gitGraphDeleteKeys(
      model,
      keys,
      strategy === "dependants" ? "dependants" : "only",
    ),
    patches: GitGraphPatch[] = [];
  if (
    [...selected].some((k) =>
      [
        "header",
        "frontmatter",
        "directive",
        "title",
        "accessibility-title",
        "accessibility-description",
      ].includes(gitGraphRecord(model, k).kind),
    )
  )
    return rejectGitGraphCommand(model, "gitgraph.delete.statement", keys[0]);
  if (strategy === "reassign") {
    const branches = document.records.filter(
        (r) => selected.has(r.sourceKey) && r.kind === "branch",
      ),
      commits =
        model.derivedGraph?.occurrences.filter((c) =>
          selected.has(c.sourceKey),
        ) ?? [];
    if (
      branches.length === 1 &&
      !commits.length &&
      target?.branchKey !== undefined
    ) {
      const branch = model.branches.find(
        (b) => b.sourceKey === target.branchKey,
      );
      if (!branch)
        return rejectGitGraphCommand(
          model,
          "gitgraph.reassign.branch",
          keys[0],
        );
      if (branch.referenceable === false)
        return rejectGitGraphCommand(
          model,
          "gitgraph.branch.reference",
          branch.sourceKey,
        );
      const lexeme = gitGraphBranchReference(model, {
        sourceKey: target.branchKey,
      });
      if (branch.sourceKey === branches[0]!.sourceKey)
        return rejectGitGraphCommand(
          model,
          "gitgraph.reassign.branch",
          keys[0],
        );
      for (const r of document.records)
        if (
          !selected.has(r.sourceKey) &&
          r.reference &&
          gitGraphReferenceRuntimeValue(r, model.derivedGraph?.sanitization) ===
            gitGraphReferenceRuntimeValue(
              branches[0]!,
              model.derivedGraph?.sanitization,
            )
        )
          patches.push({
            start: r.reference.range.start,
            end: r.reference.range.end,
            text: lexeme,
          });
      patches.push(
        gitGraphInsertPatch(
          model,
          { sourceKey: branches[0]!.sourceKey, position: "after" },
          [`checkout ${lexeme}`],
        ).patch,
      );
    } else if (commits.length === 1 && !branches.length && target?.commitKey) {
      const replacement = model.derivedGraph?.occurrences.find(
        (c) => c.sourceKey === target.commitKey,
      );
      if (!replacement?.referenceable || selected.has(replacement.sourceKey))
        return rejectGitGraphCommand(
          model,
          "gitgraph.reassign.commit",
          keys[0],
        );
      for (const r of document.records) {
        if (selected.has(r.sourceKey) || r.kind !== "cherry-pick") continue;
        const ctx = model.derivedGraph?.contexts.find(
          (c) => c.sourceKey === r.sourceKey,
        );
        for (const a of r.attributes.filter((a) =>
          ["id", "parent"].includes(a.name),
        ))
          if (
            selected.has(
              ctx?.commitIds.get(
                gitGraphSanitizeNativeValue(
                  a.nativeValue ?? a.value,
                  model.derivedGraph?.sanitization,
                ),
              ) ?? "",
            )
          ) {
            if (
              ctx?.commitIds.get(replacement.runtimeId) !==
              replacement.sourceKey
            )
              return rejectGitGraphCommand(
                model,
                "gitgraph.reassign.temporal",
                r.sourceKey,
              );
            patches.push(
              ...gitGraphAttributeLexemePatch(
                { ...r, attributes: [a] },
                a.name as "id" | "parent",
                gitGraphCommitReference(model, replacement.sourceKey),
              ),
            );
          }
      }
    } else
      return rejectGitGraphCommand(model, "gitgraph.reassign.single", keys[0]);
  }
  for (const r of document.records)
    if (selected.has(r.sourceKey))
      patches.push({
        start: r.range.start,
        end: r.range.end + r.eol.length,
        text: "",
      });
  const first = document.records.findIndex((r) => selected.has(r.sourceKey)),
    neighbour =
      document.records
        .slice(first + 1)
        .find(
          (r) =>
            !selected.has(r.sourceKey) &&
            ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
              r.kind,
            ),
        ) ??
      document.records
        .slice(0, first)
        .findLast(
          (r) =>
            !selected.has(r.sourceKey) &&
            ["commit", "branch", "checkout", "merge", "cherry-pick"].includes(
              r.kind,
            ),
        );
  return writeGitGraphPatches(model, patches, neighbour?.sourceKey);
}
