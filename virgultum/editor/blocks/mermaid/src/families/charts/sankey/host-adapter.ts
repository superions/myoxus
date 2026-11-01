// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import type { SankeyModel } from "../../../engine/charts/sankey/model.js";
import { parseSankeySource } from "../../../engine/charts/sankey/parser.js";
import {
  sankeyNoChange,
  type SankeySelection,
} from "../../../engine/charts/sankey/writer.js";
import { mermaidMessages } from "../../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../../runtime/editor-capabilities.js";
import {
  mermaidSankeyRendererToken,
  type MermaidSankeyReactHostProps,
} from "./react-host-contract.js";
import { applyMermaidSankeyFamilySourceCommand } from "./source-application.js";

function retainedSelection(
  model: SankeyModel,
  value: unknown,
): SankeySelection {
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
      : value.kind === "link"
        ? model.links
        : value.kind === "comment"
          ? model.comments
          : [];
  return objects.some((object) => object.id === value.id)
    ? (value as Exclude<SankeySelection, null>)
    : null;
}

export function sankeyEditorCapabilities(
  source: string,
  model: SankeyModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    renderSurface: "core-facade",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      // The latest local model carries writer-supplied identities. The source
      // resolver can otherwise reparse synchronously before React remounts.
      const local = context.getTransientState("sankey.model") as
        SankeyModel | undefined;
      const current =
        local?.sourceDocument.source === source
          ? local
          : local
            ? (parseSankeySource(source, local) ?? model)
            : model;
      context.setTransientState("sankey.model", current);
      const selection = retainedSelection(
        current,
        context.getTransientState("sankey.selection"),
      );
      context.setTransientState("sankey.selection", selection);
      const preview: MermaidSankeyReactHostProps["onPreviewCommand"] = (
        command,
      ) => {
        // Toolbar refreshes can reproject the same source without replacing
        // an open portal. Resolve its stable record ID against the latest
        // model instead of invalidating every callback on any host render.
        const latest = context.getTransientState("sankey.model") as
          SankeyModel | undefined;
        if (!latest) return sankeyNoChange(current, "conflict");
        return applyMermaidSankeyFamilySourceCommand({
          model: latest,
          source: latest.sourceDocument.source,
          readonly: readonly || context.getReadonly(),
          command,
        });
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidSankeyRendererToken, {
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
            context.getTransientState("sankey.data-open") === true,
          selection,
          onPreviewCommand: preview,
          onCommand: (command, options) => {
            const result = preview(command);
            if (result.changed) {
              context.setTransientState("sankey.model", result.model);
              context.setTransientState("sankey.selection", result.selection);
              context.commitSource(result.source, options);
            }
            return result;
          },
          onSelectionChange: (selection) =>
            context.setTransientState("sankey.selection", selection),
          onSelectionActionChange: context.setSelectionAction,
          onDataOpenChange: (opened) =>
            context.setTransientState("sankey.data-open", opened),
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
