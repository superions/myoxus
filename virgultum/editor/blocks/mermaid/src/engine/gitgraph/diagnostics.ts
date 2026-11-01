// SPDX-License-Identifier: AGPL-3.0-or-later
import type { GitGraphRange } from "./source-document.js";
export type GitGraphDiagnostic = {
  stage: "syntax" | "runtime" | "render";
  severity: "warning" | "error";
  code: GitGraphDiagnosticCode;
  sourceKey: string;
  range: GitGraphRange;
  reference?: string;
  message: string;
};

/** Stable causes cross the engine/family boundary; debug copy is independent of the UI locale. */
export const GITGRAPH_DIAGNOSTIC_MESSAGES = {
  "gitgraph.syntax.frontmatter-close": "Close the YAML frontmatter with ---.",
  "gitgraph.syntax.directive": "Use a valid Mermaid directive.",
  "gitgraph.syntax.accessibility-close": "Close accDescr with }.",
  "gitgraph.syntax.string-close": "Close the quoted String.",
  "gitgraph.syntax.statement":
    "Use a GitGraph statement ending at newline or EOF.",
  "gitgraph.syntax.header": "Use gitGraph, gitGraph: or gitGraph LR/TB/BT:.",
  "gitgraph.syntax.branch-reference":
    "Use a Reference or quoted String for the branch name.",
  "gitgraph.syntax.attribute":
    "Use an attribute supported by this statement; semicolons do not delimit statements.",
  "gitgraph.syntax.attribute-unsupported":
    "This statement does not support the attribute {{reference}}.",
  "gitgraph.syntax.type": "Use NORMAL, HIGHLIGHT or REVERSE.",
  "gitgraph.syntax.order": "Use a nonnegative integer for branch order.",
  "gitgraph.syntax.string": "Use a quoted String for {{reference}}.",
  "gitgraph.syntax.branch-order":
    "Branch accepts one optional order attribute.",
  "gitgraph.syntax.duplicate-header": "Keep one GitGraph header.",
  "gitgraph.syntax.header-first":
    "Place the GitGraph header before its statements.",
  "gitgraph.header": "Add a gitGraph header.",
  "gitgraph.config.ignored-init":
    "This init directive has no native configuration effect. Correct invalid init directives and use a JSON mapping with quoted keys.",
  "gitgraph.config.mapping": "Use valid YAML frontmatter.",
  "gitgraph.config.non-finite":
    "Config {{reference}} cannot produce finite renderer geometry. Use a numeric value.",
  "gitgraph.config.branch-label":
    "The native renderer needs mainBranchName to be a string or a list of strings.",
  "gitgraph.branch.reference":
    "This main branch has no string Mermaid reference. Rename it before checkout or merge.",
  "gitgraph.config.patch":
    "This Source config provider cannot be changed safely without replacing another owner.",
  "gitgraph.config.owner": "Select an existing global config provider.",
  "gitgraph.branch.duplicate":
    "Branch {{reference}} already exists. Choose another name or checkout the existing branch.",
  "gitgraph.branch.missing":
    "Branch {{reference}} does not exist at this statement. Create it first or choose an existing branch.",
  "gitgraph.branch.collision":
    "Choose a branch name without a runtime collision.",
  "gitgraph.branch.selection": "Select the branch declaration or main branch.",
  "gitgraph.branch.order-contract":
    "Branch order must match its config or statement: a branch statement needs a nonnegative integer; main-branch config needs a finite number.",
  "gitgraph.merge.self": "A merge cannot merge a branch into itself.",
  "gitgraph.merge.current-head":
    "Current branch {{reference}} needs a commit before merging.",
  "gitgraph.merge.other-head":
    "Branch {{reference}} needs a commit before merging.",
  "gitgraph.merge.same-head":
    "Both branches have the same head. Add a commit before merging.",
  "gitgraph.merge.id-duplicate":
    "Commit {{reference}} already exists. Choose another merge ID.",
  "gitgraph.cherry.source":
    "Choose a source commit with an explicit ID that exists at this statement.",
  "gitgraph.cherry.parent": "Choose an immediate parent of the source commit.",
  "gitgraph.cherry.merge-parent":
    "A merge source needs an explicit immediate parent.",
  "gitgraph.cherry.same-branch":
    "Cherry-pick needs a source on another branch.",
  "gitgraph.cherry.head":
    "Add a commit on the current branch before cherry-picking.",
  "gitgraph.cherry.generated":
    "A generated cherry result cannot receive an explicit result ID.",
  "gitgraph.cherry.temporal":
    "The selected source is not effective at the insertion location.",
  "gitgraph.cherry.promote":
    "Confirm Make ID explicit for the source and required parent.",
  "gitgraph.commit.shadowed":
    "Commit {{reference}} is overwritten later; its execution and Source record remain.",
  "gitgraph.parents.cycle":
    "The effective commit map contains an unresolved or cyclic parent. Rename the overwriting ID with reference impact.",
  "gitgraph.id.unique": "Choose a unique explicit commit ID.",
  "gitgraph.generated.attribute":
    "This generated commit has no such Source attribute.",
  "gitgraph.id.referenced":
    "A referenced ID cannot become implicit. Reassign its references first.",
  "gitgraph.attribute.missing":
    "The selected attribute occurrence no longer exists.",
  "gitgraph.selection.tags":
    "Choose commit, merge or cherry occurrences for bulk tags.",
  "gitgraph.statement.selection":
    "Choose statement occurrences and a different sequence location.",
  "gitgraph.sequence.contiguous":
    "Reorder requires one contiguous sequence block.",
  "gitgraph.delete.statement":
    "Delete statements, not the diagram header or metadata.",
  "gitgraph.reassign.branch":
    "Choose a different existing branch declaration explicitly for reassignment.",
  "gitgraph.reassign.commit": "Choose a different commit with an explicit ID.",
  "gitgraph.reassign.temporal":
    "The replacement commit does not exist at a dependent statement.",
  "gitgraph.reassign.single":
    "Reassign one branch declaration or one commit to an explicit valid target.",
  "gitgraph.accessibility.value":
    "Accessibility title is one line; a multiline description cannot contain }.",
  "gitgraph.comment.line": "Use one line per Source comment.",
  "gitgraph.comment.selection": "Select a comment occurrence.",
} as const;
export type GitGraphDiagnosticCode = keyof typeof GITGRAPH_DIAGNOSTIC_MESSAGES;
export function gitGraphDiagnostic(
  code: GitGraphDiagnosticCode,
  reference = "",
) {
  return GITGRAPH_DIAGNOSTIC_MESSAGES[code].replaceAll(
    "{{reference}}",
    reference,
  );
}
