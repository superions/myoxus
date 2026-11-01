// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import {
  parseMermaidKanbanSource,
  kanbanNoChange,
  type MermaidKanbanModel,
} from "../../engine/kanban/index.js";
import { mermaidMessages as messages } from "../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../runtime/editor-capabilities.js";
import {
  mermaidKanbanRendererToken,
  type MermaidKanbanReactHostProps,
  type MermaidKanbanSelection,
} from "./react-host-contract.js";
import { applyMermaidKanbanFamilySourceCommand } from "./source-application.js";
function validSelection(
  model: MermaidKanbanModel,
  value: MermaidKanbanSelection,
) {
  return (value?.cardId &&
    model.cards.some((card) => card.id === value.cardId)) ||
    (value?.columnId &&
      model.columns.some((column) => column.id === value.columnId))
    ? value
    : undefined;
}
export function kanbanEditorCapabilities(
  source: string,
  model: MermaidKanbanModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    displayMode: "native-preview",
    readonlyExploration: true,
    renderSurface: "core-facade",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const local = context.getTransientState("kanban.model") as
        MermaidKanbanModel | undefined;
      // Memoized projections attach only to exact previously validated source bytes.
      // The global history owner still owns replay; this cache restores its session identities/focus.
      const projections =
        (context.getTransientState("kanban.projections") as
          | Map<
              string,
              { model: MermaidKanbanModel; selection: MermaidKanbanSelection }
            >
          | undefined) ?? new Map();
      context.setTransientState("kanban.projections", projections);
      const remembered = projections.get(source);
      const replayed = Boolean(
        local && local.sourceDocument.source !== source && remembered,
      );
      const current =
        remembered?.model ??
        (local?.sourceDocument.source === source
          ? local
          : local && !model.ambiguous
            ? (parseMermaidKanbanSource(source, local) ?? model)
            : model);
      context.setTransientState("kanban.model", current);
      const selection = validSelection(
        current,
        replayed
          ? remembered?.selection
          : (context.getTransientState(
              "kanban.selection",
            ) as MermaidKanbanSelection),
      );
      context.setTransientState("kanban.selection", selection);
      projections.set(source, { model: current, selection });
      const preview: MermaidKanbanReactHostProps["onPreviewCommand"] = (
        command,
        basis = current.sourceDocument.source,
      ) => {
        if (context.getSource() !== current.sourceDocument.source)
          return kanbanNoChange(current, "conflict");
        const latest = context.getTransientState("kanban.model") as
          MermaidKanbanModel | undefined;
        return applyMermaidKanbanFamilySourceCommand(
          latest?.sourceDocument.source === source ? latest : current,
          command,
          basis,
          readonly || context.getReadonly(),
        );
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidKanbanRendererToken, {
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
              context.setTransientState("kanban.model", result.model);
              context.setTransientState(
                "kanban.selection",
                result.selection ??
                  validSelection(
                    result.model,
                    context.getTransientState(
                      "kanban.selection",
                    ) as MermaidKanbanSelection,
                  ),
              );
              projections.set(result.source, {
                model: result.model,
                selection: context.getTransientState(
                  "kanban.selection",
                ) as MermaidKanbanSelection,
              });
              context.commitSource(result.source, {
                preserveSourceBytes: true,
              });
            }
            return result;
          },
          onSelectionChange: (value) => {
            const latest =
              (context.getTransientState("kanban.model") as
                MermaidKanbanModel | undefined) ?? current;
            const selected = validSelection(latest, value);
            context.setTransientState("kanban.selection", selected);
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
