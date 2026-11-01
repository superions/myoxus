// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import type {
  TimelineSelection,
  MermaidTimelineModel,
} from "../../engine/timeline/model.js";
import { parseTimelineSource } from "../../engine/timeline/parser.js";
import { timelineNoChange } from "../../engine/timeline/writer.js";
import { mermaidMessages } from "../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../runtime/editor-capabilities.js";
import {
  mermaidTimelineRendererToken,
  type MermaidTimelineReactHostProps,
} from "./react-host-contract.js";
import { applyMermaidTimelineFamilySourceCommand } from "./source-application.js";

function retainedSelection(
  model: MermaidTimelineModel,
  value: unknown,
): TimelineSelection {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("id" in value)
  )
    return null;
  if (value.kind === "diagram" && value.id === null)
    return { kind: "diagram", id: null };
  if (typeof value.id !== "string") return null;
  const objects =
    value.kind === "section"
      ? model.sections
      : value.kind === "period"
        ? model.periods
        : value.kind === "event"
          ? model.events
          : value.kind === "comment"
            ? model.comments
            : [];
  return objects.some((item) => item.id === value.id)
    ? (value as TimelineSelection)
    : null;
}

export function timelineEditorCapabilities(
  source: string,
  model: MermaidTimelineModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    displayMode: "native-preview",
    readonlyExploration: true,
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const local = context.getTransientState("timeline.model") as
        MermaidTimelineModel | undefined;
      const current =
        local?.sourceDocument.source === source
          ? local
          : local
            ? (parseTimelineSource(source, local) ?? model)
            : model;
      context.setTransientState("timeline.model", current);
      const selection = retainedSelection(
        current,
        context.getTransientState("timeline.selection"),
      );
      context.setTransientState("timeline.selection", selection);
      const preview: MermaidTimelineReactHostProps["onPreviewCommand"] = (
        command,
        baseSource = current.sourceDocument.source,
      ) => {
        // A collaborative/source edit can land before React replaces a draft's
        // callback. Never apply that old intent over a newer persisted source.
        if (context.getSource() !== current.sourceDocument.source)
          return timelineNoChange(current, "conflict");
        const transient = context.getTransientState("timeline.model") as
          MermaidTimelineModel | undefined;
        const latest =
          transient?.sourceDocument.source === current.sourceDocument.source
            ? transient
            : current;
        return applyMermaidTimelineFamilySourceCommand({
          command,
          model: latest,
          readonly: readonly || context.getReadonly(),
          source: baseSource,
        });
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidTimelineRendererToken, {
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
          initialCommentsOpen:
            context.getTransientState("timeline.comments-open") === true,
          model: current,
          onCommand: (command, baseSource, options) => {
            const result = preview(command, baseSource);
            if (result.changed) {
              context.setTransientState("timeline.model", result.model);
              context.setTransientState(
                "timeline.selection",
                result.selection ??
                  retainedSelection(
                    result.model,
                    context.getTransientState("timeline.selection"),
                  ),
              );
              context.commitSource(result.source, {
                ...options,
                preserveSourceBytes: true,
              });
            }
            return result;
          },
          onConsumeEscape: consumeMyoxusEditorEscape,
          onCommentsOpenChange: (opened) =>
            context.setTransientState("timeline.comments-open", opened),
          onOpenSource: context.openSource,
          onPreviewCommand: preview,
          onSelectionActionChange: context.setSelectionAction,
          onSelectionChange: (next) =>
            context.setTransientState("timeline.selection", next),
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
