// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MermaidGitGraphModel } from "../model.js";
import {
  gitGraphInsertPatch,
  writeGitGraphPatches,
  gitGraphRecord,
  gitGraphBranchReference,
  gitGraphBranchTargetPatches,
  type GitGraphBranchTarget,
  type GitGraphInsertAnchor,
} from "../writer.js";
import { rejectGitGraphCommand } from "./commit-commands.js";
export function createGitGraphCheckout(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  branch: GitGraphBranchTarget,
) {
  if (
    model.branches.find((b) => b.sourceKey === branch.sourceKey)
      ?.referenceable === false
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.branch.reference",
      branch.sourceKey,
    );
  const insertion = gitGraphInsertPatch(model, anchor, [
    `checkout ${gitGraphBranchReference(model, branch)}`,
  ]);
  return writeGitGraphPatches(model, [insertion.patch], insertion.selection);
}
export function editGitGraphCheckout(
  model: MermaidGitGraphModel,
  key: string,
  branch: GitGraphBranchTarget,
) {
  if (
    model.branches.find((b) => b.sourceKey === branch.sourceKey)
      ?.referenceable === false
  )
    return rejectGitGraphCommand(
      model,
      "gitgraph.branch.reference",
      branch.sourceKey,
    );
  const r = gitGraphRecord(model, key);
  return writeGitGraphPatches(
    model,
    gitGraphBranchTargetPatches(model, r, branch),
    key,
  );
}
