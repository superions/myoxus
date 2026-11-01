// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../model.js";
import {
  gitGraphInsertPatch,
  writeGitGraphPatches,
  gitGraphRecord,
  gitGraphSetAttributePatch,
  gitGraphTagPatches,
  gitGraphContextAtAnchor,
  gitGraphCommitReference,
  gitGraphAttributeLexemePatch,
  type GitGraphTagEdit,
  type GitGraphInsertAnchor,
  type GitGraphCommandResult,
} from "../writer.js";
import { encodeGitString } from "../runtime-contract.js";
export function createGitGraphCherryPick(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  id: string,
  parent: string | null,
  tags: readonly string[],
  nativeReferences?: { id: string; parent: string | null },
) {
  const insertion = gitGraphInsertPatch(model, anchor, [
    `cherry-pick id:${nativeReferences?.id ?? encodeGitString(id)}${parent ? ` parent:${nativeReferences?.parent ?? encodeGitString(parent)}` : ""}${tags.map((t) => ` tag:${encodeGitString(t)}`).join("")}`,
  ]);
  return writeGitGraphPatches(model, [insertion.patch], insertion.selection);
}
export function editGitGraphCherryPick(
  model: MermaidGitGraphModel,
  key: string,
  sourceKey: string,
  parentKey: string | null,
  tags: readonly (string | GitGraphTagEdit)[],
  makeExplicit = false,
): GitGraphCommandResult {
  const prepared = prepareGitGraphCherryReferences(
    model,
    { sourceKey: key, position: "before" },
    sourceKey,
    parentKey,
    makeExplicit,
  );
  if (prepared.status === "rejected") return prepared;
  const current = prepared.model,
    r = gitGraphRecord(current, key),
    patches = [
      ...gitGraphAttributeLexemePatch(
        r,
        "id",
        gitGraphCommitReference(current, sourceKey),
      ),
      ...(parentKey
        ? gitGraphAttributeLexemePatch(
            r,
            "parent",
            gitGraphCommitReference(current, parentKey),
          )
        : gitGraphSetAttributePatch(r, "parent", null)),
      ...gitGraphTagPatches(r, tags),
    ];
  return finishGitGraphCherryEdit(
    model,
    prepared,
    writeGitGraphPatches(current, patches, key),
  );
}

import { gitGraphDocument } from "../writer.js";
import {
  editGitGraphCommit,
  rejectGitGraphCommand,
} from "./commit-commands.js";
/** Both creation and reference edits prepare real ID slots before writing the
 * Cherry occurrence. The consumer commits the complete result once. */
function prepareGitGraphCherryReferences(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  sourceKey: string,
  parentKey: string | null,
  makeExplicit: boolean,
): GitGraphCommandResult {
  const source = model.derivedGraph?.occurrences.find(
      (c) => c.sourceKey === sourceKey,
    ),
    parent = parentKey
      ? model.derivedGraph?.occurrences.find((c) => c.sourceKey === parentKey)
      : null;
  if (!source)
    return rejectGitGraphCommand(model, "gitgraph.cherry.source", sourceKey);
  if (parentKey && !parent)
    return rejectGitGraphCommand(model, "gitgraph.cherry.parent", parentKey);
  if (source.kind === "cherry-pick" && !source.referenceable)
    return rejectGitGraphCommand(model, "gitgraph.cherry.generated", sourceKey);
  const context = gitGraphContextAtAnchor(model, anchor);
  if (context?.commitIds.get(source.runtimeId) !== source.sourceKey)
    return rejectGitGraphCommand(model, "gitgraph.cherry.temporal", sourceKey);
  if (
    parent &&
    !source.parentReferences.some(
      (id) => context?.commitIds.get(id) === parent.sourceKey,
    )
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.cherry.parent",
      parentKey ?? sourceKey,
    );
  let prepared = writeGitGraphPatches(model, []),
    current = model;
  for (const c of [source, parent].filter((c) => !!c)) {
    if (c.referenceable) continue;
    if (c.kind === "cherry-pick")
      return rejectGitGraphCommand(
        model,
        "gitgraph.cherry.generated",
        c.sourceKey,
      );
    if (!makeExplicit)
      return rejectGitGraphCommand(
        model,
        "gitgraph.cherry.promote",
        c.sourceKey,
      );
    let i = 1,
      id: string;
    do {
      id = `commit-${i++}`;
    } while (current.derivedGraph?.effectiveMap.has(id));
    const result = editGitGraphCommit(current, c.sourceKey, { id });
    if (result.status === "rejected")
      return { ...result, source: gitGraphDocument(model).source, model };
    prepared = { ...result, impact: [...prepared.impact, ...result.impact] };
    current = result.model;
  }
  return prepared;
}

function finishGitGraphCherryEdit(
  model: MermaidGitGraphModel,
  prepared: GitGraphCommandResult,
  result: GitGraphCommandResult,
): GitGraphCommandResult {
  if (result.status === "rejected")
    return { ...result, source: gitGraphDocument(model).source, model };
  const changed = result.source !== gitGraphDocument(model).source;
  return {
    ...result,
    impact: [...prepared.impact, ...result.impact],
    changed,
    status: changed ? ("changed" as const) : ("unchanged" as const),
  };
}

export function cherryPickGitGraphOccurrence(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  sourceKey: string,
  parentKey: string | null,
  tags: readonly string[],
  makeExplicit: boolean,
): GitGraphCommandResult {
  const preparation = prepareGitGraphCherryReferences(
    model,
    anchor,
    sourceKey,
    parentKey,
    makeExplicit,
  );
  if (preparation.status === "rejected") return preparation;
  const current = preparation.model;
  const prepared = current.derivedGraph!.occurrences.find(
      (c) => c.sourceKey === sourceKey,
    )!,
    preparedParent = parentKey
      ? current.derivedGraph!.occurrences.find((c) => c.sourceKey === parentKey)
      : null;
  const result = createGitGraphCherryPick(
    current,
    anchor,
    prepared.sourceId,
    preparedParent?.sourceId ?? null,
    tags,
    {
      id: gitGraphCommitReference(current, sourceKey),
      parent: parentKey ? gitGraphCommitReference(current, parentKey) : null,
    },
  );
  return finishGitGraphCherryEdit(model, preparation, result);
}
