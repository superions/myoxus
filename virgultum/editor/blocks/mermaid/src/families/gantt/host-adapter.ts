// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import type {
  GanttSelection,
  MermaidGanttModel,
} from "../../engine/gantt/types.js";
import { parseMermaidGanttSource } from "../../engine/gantt/parser.js";
import { ganttNoChange } from "../../engine/gantt/writer.js";
import { mermaidMessages } from "../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../runtime/editor-capabilities.js";
import {
  mermaidGanttRendererToken,
  type MermaidGanttReactHostProps,
} from "./react-host-contract.js";
import { applyMermaidGanttFamilySourceCommand } from "./source-application.js";

function retainedSelection(
  model: MermaidGanttModel,
  value: unknown,
): GanttSelection {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("id" in value) ||
    typeof value.id !== "string"
  ) {
    return null;
  }
  const objects =
    value.kind === "task"
      ? model.tasks.map((task) => task.recordId)
      : value.kind === "section"
        ? model.sections.map((section) => section.id)
        : value.kind === "comment"
          ? model.comments.map((comment) => comment.id)
          : model.clicks.map((click) => click.id);
  return objects.includes(value.id) ? (value as GanttSelection) : null;
}

export function ganttEditorCapabilities(
  source: string,
  model: MermaidGanttModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    displayMode: "native-preview",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const local = context.getTransientState("gantt.model") as
        MermaidGanttModel | undefined;
      const current =
        local?.sourceDocument.source === source
          ? local
          : local
            ? (parseMermaidGanttSource(source, local) ?? model)
            : model;
      context.setTransientState("gantt.model", current);
      const selection = retainedSelection(
        current,
        context.getTransientState("gantt.selection"),
      );
      context.setTransientState("gantt.selection", selection);
      const preview: MermaidGanttReactHostProps["onPreviewCommand"] = (
        command,
      ) => {
        // A collaborative/source edit can land before React replaces a draft's
        // callback. Never apply that old intent over a newer persisted source.
        if (context.getSource() !== current.sourceDocument.source)
          return ganttNoChange(current, "conflict");
        const transient = context.getTransientState("gantt.model") as
          MermaidGanttModel | undefined;
        const latest =
          transient?.sourceDocument.source === current.sourceDocument.source
            ? transient
            : current;
        return applyMermaidGanttFamilySourceCommand({
          command,
          model: latest,
          readonly: readonly || context.getReadonly(),
          source: latest.sourceDocument.source,
        });
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidGanttRendererToken, {
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          displayOnly: Boolean(displayOnly),
          embedded: Boolean(context.embedded),
          headerActionTarget:
            displayOnly && context.embedded
              ? null
              : context.getHeaderActionTarget(),
          initialDataOpen:
            context.getTransientState("gantt.data-open") === true,
          model: current,
          onCommand: (command, options) => {
            const result = preview(command);
            if (result.changed) {
              context.setTransientState("gantt.model", result.model);
              context.setTransientState("gantt.selection", result.selection);
              context.commitSource(result.source, {
                ...options,
                preserveSourceBytes: true,
              });
            }
            return result;
          },
          onConsumeEscape: consumeMyoxusEditorEscape,
          onDataOpenChange: (opened) =>
            context.setTransientState("gantt.data-open", opened),
          onOpenSource: context.openSource,
          onPreviewCommand: preview,
          onSelectionActionChange: context.setSelectionAction,
          onSelectionChange: (next) =>
            context.setTransientState("gantt.selection", next),
          pageViewport: context.getPageViewport(),
          readonly,
          selection,
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
