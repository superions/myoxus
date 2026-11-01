// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import {
  parseMermaidJourneySource,
  journeyNoChange,
  type MermaidJourneyModel,
} from "../../engine/journey/index.js";
import { mermaidMessages as messages } from "../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../runtime/editor-capabilities.js";
import {
  mermaidJourneyRendererToken,
  type MermaidJourneyReactHostProps,
  type MermaidJourneySelection,
} from "./react-host-contract.js";
import { applyMermaidJourneyFamilySourceCommand } from "./source-application.js";
function validSelection(
  model: MermaidJourneyModel,
  value: MermaidJourneySelection,
) {
  return (value?.stepId &&
    model.steps.some((card) => card.id === value.stepId)) ||
    (value?.sectionId &&
      model.sections.some((column) => column.id === value.sectionId))
    ? value
    : undefined;
}
export function journeyEditorCapabilities(
  source: string,
  model: MermaidJourneyModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    displayMode: "native-preview",
    readonlyExploration: true,
    renderSurface: "core-facade",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const local = context.getTransientState("journey.model") as
        MermaidJourneyModel | undefined;
      // Memoized projections attach only to exact previously validated source bytes.
      // The global history owner still owns replay; this cache restores its session identities/focus.
      const projections =
        (context.getTransientState("journey.projections") as
          | Map<
              string,
              { model: MermaidJourneyModel; selection: MermaidJourneySelection }
            >
          | undefined) ?? new Map();
      context.setTransientState("journey.projections", projections);
      const remembered = projections.get(source);
      const replayed = Boolean(
        local && local.sourceDocument.source !== source && remembered,
      );
      const current =
        remembered?.model ??
        (local?.sourceDocument.source === source
          ? local
          : local && !model.ambiguous
            ? (parseMermaidJourneySource(source, local) ?? model)
            : model);
      context.setTransientState("journey.model", current);
      const selection = validSelection(
        current,
        replayed
          ? remembered?.selection
          : (context.getTransientState(
              "journey.selection",
            ) as MermaidJourneySelection),
      );
      context.setTransientState("journey.selection", selection);
      projections.set(source, { model: current, selection });
      const preview: MermaidJourneyReactHostProps["onPreviewCommand"] = (
        command,
        basis = current.sourceDocument.source,
      ) => {
        if (context.getSource() !== current.sourceDocument.source)
          return journeyNoChange(current, "conflict");
        const latest = context.getTransientState("journey.model") as
          MermaidJourneyModel | undefined;
        return applyMermaidJourneyFamilySourceCommand(
          latest?.sourceDocument.source === source ? latest : current,
          command,
          basis,
          readonly || context.getReadonly(),
        );
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidJourneyRendererToken, {
          model: current,
          readonly: Boolean(readonly),
          embedded: Boolean(context.embedded),
          displayOnly: Boolean(displayOnly),
          selection,
          replayed,
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          headerActionTarget: context.getHeaderActionTarget(),
          pageViewport: context.getPageViewport(),
          onPreviewCommand: preview,
          onCommand: (command, basis) => {
            const result = preview(command, basis);
            if (result.changed) {
              context.setTransientState("journey.model", result.model);
              context.setTransientState(
                "journey.selection",
                (result.selection
                  ? result.selection.kind === "step"
                    ? { stepId: result.selection.id }
                    : { sectionId: result.selection.id }
                  : undefined) ??
                  validSelection(
                    result.model,
                    context.getTransientState(
                      "journey.selection",
                    ) as MermaidJourneySelection,
                  ),
              );
              projections.set(result.source, {
                model: result.model,
                selection: context.getTransientState(
                  "journey.selection",
                ) as MermaidJourneySelection,
              });
              context.commitSource(result.source, {
                preserveSourceBytes: true,
              });
            }
            return result;
          },
          onSelectionChange: (value) => {
            const latest =
              (context.getTransientState("journey.model") as
                MermaidJourneyModel | undefined) ?? current;
            const selected = validSelection(latest, value);
            context.setTransientState("journey.selection", selected);
            projections.set(latest.sourceDocument.source, {
              model: latest,
              selection: selected,
            });
          },
          onExportMmd: context.exportMmd,
          onSelectionActionChange: context.setSelectionAction,
          onConsumeEscape: consumeMyoxusEditorEscape,
          onOpenSource: context.openSource,
        });
      return structuredEditorProjection(
        body ?? context.renderSourceFirst(),
        messages.visualEditorLabel(),
        Boolean(readonly),
        context.getSelectionAction(),
      );
    },
  };
}
