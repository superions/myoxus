// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import type {
  TreemapModel,
  TreemapSelection,
} from "../../../engine/charts/treemap/model.js";
import { parseTreemapSource } from "../../../engine/charts/treemap/parser.js";
import { mermaidMessages } from "../../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../../runtime/editor-capabilities.js";
import {
  mermaidTreemapRendererToken,
  type MermaidTreemapReactHostProps,
} from "./react-host-contract.js";
import { applyMermaidTreemapFamilySourceCommand } from "./source-application.js";

function retainedSelection(
  model: TreemapModel,
  value: unknown,
): TreemapSelection {
  if (
    !value ||
    typeof value !== "object" ||
    !("kind" in value) ||
    !("id" in value) ||
    typeof value.id !== "string"
  )
    return null;
  const objects =
    value.kind === "node"
      ? model.nodes
      : value.kind === "class-def"
        ? model.classDefs
        : value.kind === "comment"
          ? model.comments
          : [];
  return objects.some((object) => object.id === value.id)
    ? (value as Exclude<TreemapSelection, null>)
    : null;
}

export function treemapEditorCapabilities(
  source: string,
  model: TreemapModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    renderSurface: "core-facade",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const local = context.getTransientState("treemap.model") as
        TreemapModel | undefined;
      const current =
        local?.sourceDocument.source === source
          ? local
          : local
            ? (parseTreemapSource(source, local) ?? model)
            : model;
      context.setTransientState("treemap.model", current);
      const selection = retainedSelection(
        current,
        context.getTransientState("treemap.selection"),
      );
      context.setTransientState("treemap.selection", selection);
      const preview: MermaidTreemapReactHostProps["onPreviewCommand"] = (
        command,
      ) => {
        const transient = context.getTransientState("treemap.model") as
          TreemapModel | undefined;
        // The resolved projection owns the current persisted source. A
        // transient model contributes command identities only while it still
        // describes those exact bytes; otherwise a Source-mode edit wins.
        const latest =
          transient?.sourceDocument.source === current.sourceDocument.source
            ? transient
            : current;
        return applyMermaidTreemapFamilySourceCommand({
          model: latest,
          source: latest.sourceDocument.source,
          readonly: readonly || context.getReadonly(),
          command,
        });
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidTreemapRendererToken, {
          model: current,
          readonly,
          displayOnly: Boolean(displayOnly),
          embedded: Boolean(context.embedded),
          actionTarget: displayOnly
            ? null
            : context.embedded
              ? undefined
              : context.getActionTarget(),
          headerActionTarget:
            displayOnly && context.embedded
              ? null
              : context.getHeaderActionTarget(),
          pageViewport: context.getPageViewport(),
          initialDataOpen:
            context.getTransientState("treemap.data-open") === true,
          selection,
          onPreviewCommand: preview,
          onCommand: (command, options) => {
            const result = preview(command);
            if (result.changed) {
              context.setTransientState("treemap.model", result.model);
              context.setTransientState("treemap.selection", result.selection);
              // Commands already patch the bounded source document. Preserve
              // their EOL and trivia bytes at the global transaction boundary.
              context.commitSource(result.source, {
                ...options,
                preserveSourceBytes: true,
              });
            }
            return result;
          },
          onSelectionChange: (next) =>
            context.setTransientState("treemap.selection", next),
          onSelectionActionChange: context.setSelectionAction,
          onDataOpenChange: (opened) =>
            context.setTransientState("treemap.data-open", opened),
          onConsumeEscape: consumeMyoxusEditorEscape,
          onOpenSource: context.openSource,
        });
      return structuredEditorProjection(
        body ?? context.renderSourceFirst(),
        mermaidMessages.visualEditorLabel(),
        readonly,
        context.getSelectionAction(),
      );
    },
  };
}
