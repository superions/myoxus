// SPDX-License-Identifier: AGPL-3.0-or-later
import { mermaidMessages as m } from "../../i18n.js";
import type {
  GitGraphDiagnostic,
  GitGraphDiagnosticCode,
} from "../../engine/gitgraph/diagnostics.js";
const causes = {
  "gitgraph.syntax.frontmatter-close": m.gitGraphDiagnosticFrontmatterClose,
  "gitgraph.syntax.directive": m.gitGraphDiagnosticDirective,
  "gitgraph.syntax.accessibility-close": m.gitGraphDiagnosticAccessibilityClose,
  "gitgraph.syntax.string-close": m.gitGraphDiagnosticStringClose,
  "gitgraph.syntax.statement": m.gitGraphDiagnosticStatement,
  "gitgraph.syntax.header": m.gitGraphDiagnosticHeader,
  "gitgraph.syntax.branch-reference": m.gitGraphDiagnosticBranchReference,
  "gitgraph.syntax.attribute": m.gitGraphDiagnosticAttribute,
  "gitgraph.syntax.attribute-unsupported":
    m.gitGraphDiagnosticAttributeUnsupported,
  "gitgraph.syntax.type": m.gitGraphDiagnosticType,
  "gitgraph.syntax.order": m.gitGraphDiagnosticOrder,
  "gitgraph.syntax.string": m.gitGraphDiagnosticString,
  "gitgraph.syntax.branch-order": m.gitGraphDiagnosticBranchOrder,
  "gitgraph.syntax.duplicate-header": m.gitGraphDiagnosticDuplicateHeader,
  "gitgraph.syntax.header-first": m.gitGraphDiagnosticHeaderFirst,
  "gitgraph.header": m.gitGraphDiagnosticMissingHeader,
  "gitgraph.config.ignored-init": m.gitGraphDiagnosticIgnoredInit,
  "gitgraph.config.mapping": m.gitGraphDiagnosticMapping,
  "gitgraph.config.non-finite": m.gitGraphDiagnosticNonFiniteConfig,
  "gitgraph.config.branch-label": m.gitGraphDiagnosticBranchLabel,
  "gitgraph.branch.reference": m.gitGraphDiagnosticBranchUnreferenceable,
  "gitgraph.config.patch": m.gitGraphDiagnosticConfigPatch,
  "gitgraph.config.owner": m.gitGraphDiagnosticConfigOwner,
  "gitgraph.branch.duplicate": m.gitGraphDiagnosticDuplicateBranch,
  "gitgraph.branch.missing": m.gitGraphDiagnosticMissingBranch,
  "gitgraph.branch.collision": m.gitGraphDiagnosticBranchCollision,
  "gitgraph.branch.selection": m.gitGraphDiagnosticBranchSelection,
  "gitgraph.branch.order-contract": m.gitGraphDiagnosticOrderContract,
  "gitgraph.merge.self": m.gitGraphDiagnosticSelfMerge,
  "gitgraph.merge.current-head": m.gitGraphDiagnosticCurrentHead,
  "gitgraph.merge.other-head": m.gitGraphDiagnosticOtherHead,
  "gitgraph.merge.same-head": m.gitGraphDiagnosticSameHead,
  "gitgraph.merge.id-duplicate": m.gitGraphDiagnosticMergeIdDuplicate,
  "gitgraph.cherry.source": m.gitGraphDiagnosticCherrySource,
  "gitgraph.cherry.parent": m.gitGraphDiagnosticCherryParent,
  "gitgraph.cherry.merge-parent": m.gitGraphDiagnosticMergeParent,
  "gitgraph.cherry.same-branch": m.gitGraphDiagnosticCherrySameBranch,
  "gitgraph.cherry.head": m.gitGraphDiagnosticCherryHead,
  "gitgraph.cherry.generated": m.gitGraphDiagnosticCherryGenerated,
  "gitgraph.cherry.temporal": m.gitGraphDiagnosticCherryTemporal,
  "gitgraph.cherry.promote": m.gitGraphDiagnosticCherryPromote,
  "gitgraph.commit.shadowed": m.gitGraphDiagnosticShadowedCommit,
  "gitgraph.parents.cycle": m.gitGraphDiagnosticParentCycle,
  "gitgraph.id.unique": m.gitGraphDiagnosticUniqueId,
  "gitgraph.generated.attribute": m.gitGraphDiagnosticGeneratedAttribute,
  "gitgraph.id.referenced": m.gitGraphDiagnosticReferencedId,
  "gitgraph.attribute.missing": m.gitGraphDiagnosticMissingAttribute,
  "gitgraph.selection.tags": m.gitGraphDiagnosticTagsSelection,
  "gitgraph.statement.selection": m.gitGraphDiagnosticStatementSelection,
  "gitgraph.sequence.contiguous": m.gitGraphDiagnosticContiguous,
  "gitgraph.delete.statement": m.gitGraphDiagnosticDeleteStatement,
  "gitgraph.reassign.branch": m.gitGraphDiagnosticReassignBranch,
  "gitgraph.reassign.commit": m.gitGraphDiagnosticReassignCommit,
  "gitgraph.reassign.temporal": m.gitGraphDiagnosticReassignTemporal,
  "gitgraph.reassign.single": m.gitGraphDiagnosticReassignSingle,
  "gitgraph.accessibility.value": m.gitGraphDiagnosticAccessibilityValue,
  "gitgraph.comment.line": m.gitGraphDiagnosticCommentLine,
  "gitgraph.comment.selection": m.gitGraphDiagnosticCommentSelection,
} satisfies Record<GitGraphDiagnosticCode, (reference?: string) => string>;
/** Use the Source owning these ranges, including rejected candidates and last-valid repair. */
export function formatGitGraphDiagnostic(
  d: GitGraphDiagnostic,
  source: string,
) {
  const lineStart =
    Math.max(
      source.lastIndexOf("\n", d.range.start - 1),
      source.lastIndexOf("\r", d.range.start - 1),
    ) + 1;
  const construct =
    /^[ \t]*([\w-]+)/.exec(source.slice(lineStart))?.[1] ?? "GitGraph";
  return m.gitGraphDiagnostic(
    d.range.line,
    d.range.start,
    d.range.end,
    construct,
    causes[d.code](d.reference),
  );
}
