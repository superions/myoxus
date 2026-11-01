// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidPieModel } from "../../../engine/charts/pie/model.js";
import {
  diagnoseMermaidPieSliceDraft,
  nextMermaidPieSliceLabel,
} from "../../../engine/charts/pie/commands.js";
import { mermaidMessages } from "../../../i18n.js";
import {
  type MermaidEditorCapabilities,
  structuredEditorProjection,
} from "../../runtime/editor-capabilities.js";
import { mermaidPieRendererToken } from "./react-host-contract.js";
import { applyMermaidPieFamilySourceCommand } from "./source-application.js";

export function pieEditorCapabilities(
  source: string,
  model: MermaidPieModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidPieRendererToken, {
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          commentsForSlice: (sliceId) =>
            model.comments.filter(
              (comment) =>
                comment.anchorKind === "slice" && comment.anchorId === sliceId,
            ),
          diagramComments: model.comments.filter(
            (comment) => comment.anchorKind !== "slice",
          ),
          embedded: Boolean(context.embedded),
          labels: {
            add: mermaidMessages.structuredAddEntry(),
            addComment: mermaidMessages.architectureAddComment(),
            apply: mermaidMessages.architectureApply(),
            appearance: mermaidMessages.visualAppearance(),
            accessibilityDescription:
              mermaidMessages.visualAccessibilityDescription(),
            accessibilityTitle: mermaidMessages.visualAccessibilityTitle(),
            cancel: mermaidMessages.cancel(),
            chart: mermaidMessages.visualEditorLabel(),
            comments: mermaidMessages.visualComments(),
            data: mermaidMessages.pieData(),
            delete: mermaidMessages.visualDelete(),
            deleteComment: mermaidMessages.visualDeleteComment(),
            donutHole: mermaidMessages.pieDonutHole(),
            down: mermaidMessages.visualMoveDown(),
            empty: mermaidMessages.previewEmpty(),
            exportMmd: mermaidMessages.mmdExport(),
            highlightHover: mermaidMessages.pieHighlightHover(),
            highlightNone: mermaidMessages.pieHighlightNone(),
            highlightSlice: mermaidMessages.pieHighlightSlice(),
            inspector: mermaidMessages.visualInspector(),
            invalid: mermaidMessages.pieInvalid(),
            label: mermaidMessages.selectedNodeLabel(),
            legendPosition: mermaidMessages.pieLegendPosition(),
            legendPositions: {
              bottom: mermaidMessages.pieLegendBottom(),
              center: mermaidMessages.pieLegendCenter(),
              left: mermaidMessages.pieLegendLeft(),
              right: mermaidMessages.pieLegendRight(),
              top: mermaidMessages.pieLegendTop(),
            },
            more: mermaidMessages.visualMoreActions(),
            showData: mermaidMessages.pieShowData(),
            sourceChanged: mermaidMessages.pieSourceChanged(),
            textPosition: mermaidMessages.pieTextPosition(),
            up: mermaidMessages.visualMoveUp(),
            value: mermaidMessages.selectedPieValue(),
            zeroValues: mermaidMessages.pieZeroValues(),
          },
          items: model.slices.map((slice) => ({
            id: slice.id,
            issue: model.conflicts.some(
              (conflict) => conflict.firstSliceId === slice.id,
            )
              ? mermaidMessages.pieDuplicateConflict()
              : undefined,
            label: slice.label,
            value: slice.value,
          })),
          model,
          newSliceLabel: nextMermaidPieSliceLabel(
            model,
            mermaidMessages.structuredAddEntry(),
          ),
          onCommand: (command, options) => {
            const result = applyMermaidPieFamilySourceCommand({
              baseSourceHash: model.sourceHash,
              command,
              model,
              readonly,
              source,
            });
            if (!result.changed) return null;
            context.commitSource(result.source, options);
            return result.selectionAfter;
          },
          onExportMmd: () => context.exportMmd?.(),
          onSelectionActionChange: context.setSelectionAction,
          pageViewport: context.getPageViewport(),
          readonly,
          sliceOptions: model.slices.map((slice) => ({
            label: slice.label,
            value: slice.id,
          })),
          sliceIdForLabel: (label) =>
            model.slices.find((slice) => slice.label === label)?.id,
          sliceLabelForId: (sliceId) =>
            model.slices.find((slice) => slice.id === sliceId)?.label,
          validateSliceDraft: (label, value) =>
            diagnoseMermaidPieSliceDraft(model, label, value),
        });
      return structuredEditorProjection(
        body ?? context.renderSourceFirst(),
        mermaidMessages.visualEditorLabel(),
        readonly,
        context.getSelectionAction(),
      );
    },
    renderSurface: "core-facade",
  };
}
