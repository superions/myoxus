// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGitGraphModel } from "../model.js";

import {
  gitGraphInsertPatch,
  gitGraphBranchReference,
  type GitGraphBranchTarget,
  writeGitGraphPatches,
  type GitGraphInsertAnchor,
} from "../writer.js";
import { encodeGitString } from "../runtime-contract.js";
import {
  editGitGraphCommit,
  rejectGitGraphCommand,
} from "./commit-commands.js";
export function createGitGraphMerge(
  model: MermaidGitGraphModel,
  anchor: GitGraphInsertAnchor,
  branch: GitGraphBranchTarget,
  values: {
    id: string;
    type: import("../model.js").MermaidGitSourceCommitType | null;
    tags: readonly string[];
  },
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
  const statement = `merge ${gitGraphBranchReference(model, branch)}${values.id ? ` id:${encodeGitString(values.id)}` : ""}${values.type ? ` type:${values.type}` : ""}${values.tags.map((t) => ` tag:${encodeGitString(t)}`).join("")}`;
  const insertion = gitGraphInsertPatch(model, anchor, [statement]);
  return writeGitGraphPatches(model, [insertion.patch], insertion.selection);
}
export function editGitGraphMerge(
  model: MermaidGitGraphModel,
  key: string,
  values: Parameters<typeof editGitGraphCommit>[2],
  branch?: GitGraphBranchTarget,
) {
  return editGitGraphCommit(model, key, { ...values, branchTarget: branch });
}
