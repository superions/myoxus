// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../../engine/gitgraph/index.js";
import type {
  MermaidVisualNode,
  MermaidVisualEdge,
} from "../runtime/gfx-model.js";
import { gitGraphData, gitGraphBinding, gitGraphPayload } from "./gfx-data.js";
import { mermaidMessages as m } from "../../i18n.js";

/** Source-derived context; localized names are resolved locally, never persisted. */
export function gitGraphAccessibleContext(
  model: MermaidGitGraphModel,
  object: MermaidVisualNode | MermaidVisualEdge,
) {
  const binding = gitGraphBinding(object);
  if (!binding) return object.familyData;
  const graph = model.derivedGraph;
  const commit = graph?.occurrences.find(
    (c) => c.sourceKey === binding.sourceKey,
  );
  const record = model.sourceDocument?.records.find(
    (r) => r.sourceKey === binding.sourceKey,
  );
  const branch = model.branches.find((b) => b.id === binding.branch);
  const name = (key: string) =>
    graph?.occurrences.find((c) => c.sourceKey === key)?.sourceId ||
    graph?.occurrences.find((c) => c.sourceKey === key)?.kind ||
    "";
  const head = branch && graph?.finalContext.branchHeads.get(branch.id);
  return gitGraphData({
    ...gitGraphPayload(object),
    occurrenceKind: record?.kind ?? null,
    commitKind: commit?.kind ?? null,
    symbol: commit ? (commit.customType ?? commit.type) : null,
    parents: commit?.executionParents.map(name) ?? [],
    tags: commit?.tags ?? [],
    shadowed: commit?.shadowed ?? false,
    relationshipParent:
      typeof gitGraphPayload(object)?.parent === "string"
        ? name(gitGraphPayload(object)!.parent as string)
        : null,
    branchName: branch?.name ?? null,
    active: !!branch && graph?.finalContext.branch === branch.id,
    headName: head ? name(head) : null,
    originName:
      typeof gitGraphPayload(object)?.origin === "string"
        ? name(gitGraphPayload(object)!.origin as string)
        : null,
  });
}

export function gitGraphAccessibleName(
  object: MermaidVisualNode | MermaidVisualEdge | undefined,
) {
  if (!object) return "";
  const binding = gitGraphBinding(object),
    data = gitGraphPayload(object);
  if (!binding || !data) return object.label;
  const kind =
    data.commitKind === "merge"
      ? m.gitGraphMerge()
      : data.commitKind === "cherry-pick"
        ? m.gitGraphCherryPick()
        : m.gitGraphCommit();
  const role =
    binding.role === "relationship"
      ? data.kind === "origin"
        ? m.gitGraphOrigin()
        : data.kind === "cherry"
          ? m.gitGraphCherryPick()
          : data.kind === "merge"
            ? m.gitGraphMerge()
            : m.chartParent()
      : binding.role === "branch"
        ? object.id.endsWith(":head")
          ? m.gitGraphHead()
          : object.id.endsWith(":origin")
            ? m.gitGraphOrigin()
            : m.sequenceBranch()
        : binding.role === "id"
          ? m.sequenceId()
          : binding.role === "message"
            ? m.sequenceMessage()
            : binding.role === "tag"
              ? m.selectedC4Tags()
              : binding.role === "comment"
                ? m.visualComments()
                : binding.role === "statement" &&
                    data.occurrenceKind === "checkout"
                  ? m.gitGraphCheckout()
                  : kind;
  const values = [role, object.label];
  if (binding.role === "tag" && binding.tagIndex !== undefined)
    values.push(String(binding.tagIndex + 1));
  if (typeof data.relationshipParent === "string")
    values.push(data.relationshipParent);
  if (binding.role !== "comment") {
    if (typeof data.symbol === "string") values.push(data.symbol);
    if (typeof data.branchName === "string")
      values.push(`${m.sequenceBranch()}: ${data.branchName}`);
    if (data.active) values.push(m.gitGraphActive());
    if (typeof data.headName === "string")
      values.push(`${m.gitGraphHead()}: ${data.headName}`);
    if (Array.isArray(data.parents) && data.parents.length)
      values.push(`${m.chartParent()}: ${data.parents.join(", ")}`);
    if (Array.isArray(data.tags) && data.tags.length)
      values.push(`${m.selectedC4Tags()}: ${data.tags.join(", ")}`);
    if (typeof data.originName === "string")
      values.push(`${m.gitGraphOrigin()}: ${data.originName}`);
    if (data.shadowed) values.push(m.gitGraphShadowed());
  }
  return values.filter(Boolean).join(" · ");
}
