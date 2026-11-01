// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidQuadrantModel } from "../../../engine/charts/quadrant/model.js";
import type { MermaidQuadrantCommand } from "../../../engine/charts/quadrant/commands/types.js";
import { mermaidMessages } from "../../../i18n.js";
import {
  type MermaidEditorCapabilities,
  structuredEditorProjection,
} from "../../runtime/editor-capabilities.js";
import { mermaidQuadrantRendererToken } from "./react-host-contract.js";
import { applyMermaidQuadrantFamilySourceCommand } from "./source-application.js";
import { localizedQuadrantDiagnostic } from "./family.js";

export function quadrantEditorCapabilities(
  source: string,
  model: MermaidQuadrantModel,
): MermaidEditorCapabilities {
  const localizedModel: MermaidQuadrantModel = {
    ...model,
    diagnostics: model.diagnostics.map(localizedQuadrantDiagnostic),
  };
  return {
    kind: "structured",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidQuadrantRendererToken, {
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          comments: model.comments,
          embedded: Boolean(context.embedded),
          labels: {
            accessibilityDescription:
              mermaidMessages.visualAccessibilityDescription(),
            accessibilityTitle: mermaidMessages.visualAccessibilityTitle(),
            add: mermaidMessages.chartAddPoint(),
            addComment: mermaidMessages.architectureAddComment(),
            apply: mermaidMessages.architectureApply(),
            appearance: mermaidMessages.visualAppearance(),
            bottom: mermaidMessages.pieLegendBottom(),
            cancel: mermaidMessages.cancel(),
            chart: mermaidMessages.visualEditorLabel(),
            classes: mermaidMessages.quadrantClass(),
            classDefinitions: mermaidMessages.quadrantClassDefinitions(),
            comments: mermaidMessages.visualComments(),
            coordinates: mermaidMessages.quadrantCoordinates(),
            data: mermaidMessages.pieData(),
            delete: mermaidMessages.visualDelete(),
            deleteComment: mermaidMessages.visualDeleteComment(),
            down: mermaidMessages.visualMoveDown(),
            empty: mermaidMessages.previewEmpty(),
            exportMmd: mermaidMessages.mmdExport(),
            invalid: mermaidMessages.pieInvalid(),
            label: mermaidMessages.quadrantPointLabel(),
            labelForm: mermaidMessages.quadrantLabelForm(),
            left: mermaidMessages.pieLegendLeft(),
            markdown: mermaidMessages.quadrantMarkdown(),
            more: mermaidMessages.visualMoreActions(),
            plain: mermaidMessages.quadrantPlain(),
            pointRadius: mermaidMessages.quadrantPointRadius(),
            position: mermaidMessages.quadrantPosition(),
            quoted: mermaidMessages.quadrantQuoted(),
            quadrantLabel: mermaidMessages.quadrantLabel(),
            reset: mermaidMessages.architectureReset(),
            right: mermaidMessages.pieLegendRight(),
            fillColor: mermaidMessages.quadrantFillColor(),
            fontSize: mermaidMessages.quadrantFontSize(),
            height: mermaidMessages.quadrantHeight(),
            internalBorder: mermaidMessages.quadrantInternalBorder(),
            externalBorder: mermaidMessages.quadrantExternalBorder(),
            useMaxWidth: mermaidMessages.quadrantUseMaxWidth(),
            width: mermaidMessages.quadrantWidth(),
            padding: mermaidMessages.quadrantPadding(),
            strokeColor: mermaidMessages.quadrantStrokeColor(),
            strokeWidth: mermaidMessages.quadrantStrokeWidth(),
            style: mermaidMessages.quadrantInlineStyle(),
            top: mermaidMessages.pieLegendTop(),
            sourceChanged: mermaidMessages.pieSourceChanged(),
            up: mermaidMessages.visualMoveUp(),
            x: mermaidMessages.chartX(),
            xAxisEnd: mermaidMessages.chartXAxisEnd(),
            xAxisStart: mermaidMessages.chartXAxisStart(),
            y: mermaidMessages.chartY(),
            yAxisEnd: mermaidMessages.chartYAxisEnd(),
            yAxisStart: mermaidMessages.chartYAxisStart(),
          },
          model: localizedModel,
          onCommand: (command, options) => {
            const commands: readonly MermaidQuadrantCommand[] = Array.isArray(
              command,
            )
              ? command
              : [command as MermaidQuadrantCommand];
            let currentModel = model;
            let currentSource = source;
            let selection = null;
            let changed = false;
            for (const concreteCommand of commands) {
              const result = applyMermaidQuadrantFamilySourceCommand({
                baseSourceHash: currentModel.sourceHash,
                command: concreteCommand,
                model: currentModel,
                readonly,
                source: currentSource,
              });
              // A grouped UI Apply is one source/history transaction. Any
              // stale, invalid or unavailable member aborts the whole batch;
              // partial commits would make the visible draft lie.
              if (!result.changed) return null;
              currentModel = result.model;
              currentSource = result.source;
              selection = result.selectionAfter;
              changed = true;
            }
            if (!changed) return null;
            context.commitSource(currentSource, options);
            return selection;
          },
          onExportMmd: () => context.exportMmd?.(),
          onSelectionActionChange: context.setSelectionAction,
          pageViewport: context.getPageViewport(),
          readonly,
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
