// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../model.js";
import {
  gitGraphInsertPatch,
  writeGitGraphPatches,
  gitGraphDocument,
  gitGraphRecord,
  gitGraphSetAttributePatch,
  gitGraphReferencePatch,
  gitGraphBranchReference,
  type GitGraphInsertAnchor,
} from "../writer.js";
import {
  encodeGitReference,
  encodeGitGraphBranchOrder,
} from "../runtime-contract.js";
import { rejectGitGraphCommand } from "./commit-commands.js";
import {
  gitGraphRuntimeText,
  gitGraphReferenceRuntimeValue,
  gitGraphAttribute,
} from "../derived-graph.js";
import { gitGraphConfigPatch } from "../config.js";
export function createGitGraphBranch(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  name: string,
  order: number | null,
  continueOnBranch = false,
) {
  if (
    model.branches.some(
      (b) =>
        b.id === gitGraphRuntimeText(name, model.derivedGraph?.sanitization),
    )
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.branch.collision",
      anchor.sourceKey ?? undefined,
    );
  if (order !== null && (!Number.isInteger(order) || order < 0))
    return rejectGitGraphCommand(
      model,
      "gitgraph.syntax.order",
      anchor.sourceKey ?? undefined,
    );
  const r = anchor.sourceKey ? gitGraphRecord(model, anchor.sourceKey) : null;
  const next =
    r && anchor.position === "after"
      ? gitGraphDocument(model).records.find(
          (n) => n.range.start >= r.range.end + r.eol.length,
        )
      : r;
  const context = next
    ? model.derivedGraph?.contexts.find((c) => c.sourceKey === next.sourceKey)
    : model.derivedGraph?.finalContext;
  const statements = [
    `branch ${encodeGitReference(name)}${order === null ? "" : ` order: ${encodeGitGraphBranchOrder(order)}`}`,
  ];
  if (!continueOnBranch && next && context) {
    const branch = model.branches.find((b) => b.id === context.branch);
    if (branch?.referenceable === false)
      return rejectGitGraphCommand(
        model,
        "gitgraph.branch.reference",
        branch.sourceKey,
      );
    if (branch?.sourceKey)
      statements.push(
        `checkout ${gitGraphBranchReference(model, { sourceKey: branch.sourceKey })}`,
      );
  }
  const inserted = gitGraphInsertPatch(model, anchor, statements);
  return writeGitGraphPatches(model, [inserted.patch], inserted.selection);
}
export function editGitGraphBranch(
  model: MermaidGitGraphModel,
  key: string,
  values: { name?: string; order?: number | null },
): import("../writer.js").GitGraphCommandResult {
  const record = gitGraphRecord(model, key),
    main = record.kind === "header",
    oldName = main ? model.mainBranchName : record.reference?.value,
    oldRuntimeName = main
      ? model.mainBranchId
      : gitGraphReferenceRuntimeValue(record, model.derivedGraph?.sanitization);
  if (oldName === undefined || (!main && record.kind !== "branch"))
    return rejectGitGraphCommand(model, "gitgraph.branch.selection", key);
  if (main && values.name !== undefined && values.order !== undefined) {
    const renamed = editGitGraphBranch(model, key, { name: values.name });
    if (renamed.status === "rejected") return renamed;
    const ordered = editGitGraphBranch(renamed.model, key, {
      order: values.order,
    });
    if (ordered.status === "rejected")
      return { ...ordered, model, source: gitGraphDocument(model).source };
    const changed = ordered.source !== gitGraphDocument(model).source;
    return {
      ...ordered,
      changed,
      status: changed ? ("changed" as const) : ("unchanged" as const),
      impact: [...renamed.impact, ...ordered.impact],
    };
  }
  const name = values.name ?? oldName;
  if (
    values.name !== undefined &&
    model.branches.some(
      (b) =>
        b.id !== oldRuntimeName &&
        b.id ===
          (main
            ? name
            : gitGraphRuntimeText(name, model.derivedGraph?.sanitization)),
    )
  )
    return rejectGitGraphCommand(model, "gitgraph.branch.collision", key);
  const patches = [];
  if (
    name !== oldName ||
    (main &&
      values.name !== undefined &&
      model.branches[0]?.referenceable === false)
  ) {
    if (main) {
      const result = gitGraphConfigPatch(
        gitGraphDocument(model),
        "mainBranchName",
        name,
      );
      if (!result)
        return rejectGitGraphCommand(
          model,
          "gitgraph.config.patch",
          gitGraphDocument(model).records.find(
            (r) => r.kind === "frontmatter" || r.kind === "directive",
          )?.sourceKey,
        );
      patches.push(
        ...result.map((p) => ({
          start: p.range.start,
          end: p.range.end,
          text: p.value,
        })),
      );
    }
    for (const r of gitGraphDocument(model).records)
      if (
        r.reference &&
        gitGraphReferenceRuntimeValue(r, model.derivedGraph?.sanitization) ===
          oldRuntimeName
      )
        patches.push(gitGraphReferencePatch(r, name));
  }
  if (values.order !== undefined) {
    if (
      values.order !== null &&
      (!Number.isFinite(values.order) ||
        (!main && (!Number.isInteger(values.order) || values.order < 0)))
    )
      return rejectGitGraphCommand(
        model,
        "gitgraph.branch.order-contract",
        key,
      );
    if (main) {
      const result = gitGraphConfigPatch(
        gitGraphDocument(model),
        "mainBranchOrder",
        values.order ?? 0,
      );
      if (!result)
        return rejectGitGraphCommand(
          model,
          "gitgraph.config.patch",
          gitGraphDocument(model).records.find(
            (r) => r.kind === "frontmatter" || r.kind === "directive",
          )?.sourceKey,
        );
      patches.push(
        ...result.map((p) => ({
          start: p.range.start,
          end: p.range.end,
          text: p.value,
        })),
      );
    } else if (
      values.order === null ||
      Number(gitGraphAttribute(record, "order")) !== values.order
    )
      patches.push(
        ...gitGraphSetAttributePatch(
          record,
          "order",
          values.order === null
            ? null
            : encodeGitGraphBranchOrder(values.order),
        ),
      );
  }
  return writeGitGraphPatches(model, patches, key);
}
