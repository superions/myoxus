// SPDX-License-Identifier: AGPL-3.0-or-later
import * as engine from "../../engine/gitgraph/index.js";
import { gitGraphAccessibleName } from "./accessibility.js";
import { gitGraphBinding } from "./gfx-data.js";
import type { MermaidPageSelectionToolsContribution } from "../runtime/contracts.js";
export const GITGRAPH_COMMANDS = {
  editGitGraphAttributeOccurrence: engine.editGitGraphAttributeOccurrence,
  addGitGraphCommit: engine.addGitGraphCommit,
  editGitGraphCommit: engine.editGitGraphCommit,
  editGitGraphBulkTags: engine.editGitGraphBulkTags,
  createGitGraphBranch: engine.createGitGraphBranch,
  editGitGraphBranch: engine.editGitGraphBranch,
  createGitGraphCheckout: engine.createGitGraphCheckout,
  editGitGraphCheckout: engine.editGitGraphCheckout,
  createGitGraphMerge: engine.createGitGraphMerge,
  editGitGraphMerge: engine.editGitGraphMerge,
  createGitGraphCherryPick: engine.createGitGraphCherryPick,
  editGitGraphCherryPick: engine.editGitGraphCherryPick,
  cherryPickGitGraphOccurrence: engine.cherryPickGitGraphOccurrence,
  moveGitGraphStatements: engine.moveGitGraphStatements,
  deleteGitGraphStatements: engine.deleteGitGraphStatements,
  editGitGraphComment: engine.editGitGraphComment,
  editGitGraphAccessibility: engine.editGitGraphAccessibility,
  editGitGraphConfig: engine.editGitGraphConfig,
  editGitGraphGlobalOption: engine.editGitGraphGlobalOption,
  editGitGraphGlobalConfig: engine.editGitGraphGlobalConfig,
};
export type GitGraphCommandName = keyof typeof GITGRAPH_COMMANDS;
export type GitGraphCommandArgs<K extends GitGraphCommandName> =
  Parameters<(typeof GITGRAPH_COMMANDS)[K]> extends [
    engine.MermaidGitGraphModel,
    ...infer Args,
  ]
    ? Args
    : never;
export function runGitGraphCommand<K extends GitGraphCommandName>(
  model: engine.MermaidGitGraphModel,
  name: K,
  args: GitGraphCommandArgs<K>,
): engine.GitGraphCommandResult {
  return (
    GITGRAPH_COMMANDS[name] as unknown as (
      model: engine.MermaidGitGraphModel,
      ...args: GitGraphCommandArgs<K>
    ) => engine.GitGraphCommandResult
  )(model, ...args);
}
export const gitGraphPageSelectionTools: MermaidPageSelectionToolsContribution =
  {
    boxSelectableKinds: ["node"],
    selectableKinds: ["node", "edge"],
    selectAllKinds: ["node"],
    operations: {
      deleteSelection: true,
      duplicateSelection: false,
      moveSelection: false,
    },
    resolveItems: (model) => [
      ...model.nodes
        .filter((n) => {
          const b = gitGraphBinding(n);
          return !!b && b.role !== "rail";
        })
        .map((n) => {
          const role = gitGraphBinding(n)!.role;
          return {
            kind: "node" as const,
            editKey: n.id,
            label: gitGraphAccessibleName(n),
            boxSelectable: [
              "commit",
              "branch",
              "statement",
              "comment",
            ].includes(role),
            selectAllSelectable: [
              "commit",
              "branch",
              "statement",
              "comment",
            ].includes(role),
          };
        }),
      ...model.edges.map((e) => ({
        kind: "edge" as const,
        editKey: e.id,
        label: gitGraphAccessibleName(e),
        boxSelectable: false,
        selectAllSelectable: false,
      })),
    ],
  };
export const GITGRAPH_ACTIONS = [
  "commit",
  "branch",
  "checkout",
  "merge",
  "cherry-pick",
  "comments",
  "settings",
  "accessibility",
  "data",
  "reorder",
  "deleteSelection",
  "bulk-tags",
] as const;
export type GitGraphAction = (typeof GITGRAPH_ACTIONS)[number];

import { mermaidMessages as m } from "../../i18n.js";
export const gitGraphActionLabel = (action: GitGraphAction) =>
  ({
    commit: m.gitGraphCommit,
    branch: m.sequenceBranch,
    checkout: m.gitGraphCheckout,
    merge: m.gitGraphMerge,
    "cherry-pick": m.gitGraphCherryPick,
    comments: m.visualComments,
    settings: m.visualAppearance,
    accessibility: m.visualAccessibility,
    data: m.pieData,
    reorder: m.gitGraphReorder,
    deleteSelection: m.visualDelete,
    "bulk-tags": m.selectedCommitTag,
  })[action]();
