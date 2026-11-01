// SPDX-License-Identifier: AGPL-3.0-or-later

import { consumeMyoxusEditorEscape } from "@virgultum/shared/utils";
import {
  parseMermaidPacketSource,
  packetNoChange,
  type MermaidPacketModel,
} from "../../engine/packet/index.js";
import { mermaidMessages as messages } from "../../i18n.js";
import {
  structuredEditorProjection,
  type MermaidEditorCapabilities,
} from "../runtime/editor-capabilities.js";
import {
  mermaidPacketRendererToken,
  type MermaidPacketReactHostProps,
} from "./react-host-contract.js";
import { applyMermaidPacketFamilySourceCommand } from "./source-application.js";
function validSelection(model: MermaidPacketModel, value: string | undefined) {
  return model.fields.some((f) => f.id === value) ? value : undefined;
}
export function packetEditorCapabilities(
  source: string,
  model: MermaidPacketModel,
  projectionModel?: MermaidPacketModel,
): MermaidEditorCapabilities {
  return {
    kind: "structured",
    sourcePreview: "native-preview",
    readonlyExploration: true,
    renderSurface: "core-facade",
    project: (context, displayOnly) => {
      const readonly = context.getReadonly() || displayOnly;
      const local = context.getTransientState("packet.model") as
        MermaidPacketModel | undefined;
      // Memoized projections attach only to exact previously validated source bytes.
      // The global history owner still owns replay; this cache restores its session identities/focus.
      const projections =
        (context.getTransientState("packet.projections") as
          | Map<
              string,
              { model: MermaidPacketModel; selection: string | undefined }
            >
          | undefined) ?? new Map();
      context.setTransientState("packet.projections", projections);
      const remembered = projections.get(source);
      const replayed = Boolean(
        local && local.sourceDocument.source !== source && remembered,
      );
      const current =
        remembered?.model ??
        (local?.sourceDocument.source === source
          ? local
          : local
            ? (parseMermaidPacketSource(source, local) ?? model)
            : model);
      context.setTransientState("packet.model", current);
      const valid =
        !current.issues.length &&
        !current.diagnostics.length &&
        current.configResolution.mutableGeometry;
      if (valid) context.setTransientState("packet.last-valid", current);
      const projected = valid
        ? undefined
        : (projectionModel ??
          (context.getTransientState("packet.last-valid") as
            MermaidPacketModel | undefined));
      const selection = validSelection(
        projected ?? current,
        replayed
          ? remembered?.selection
          : (context.getTransientState("packet.selection") as
              string | undefined),
      );
      context.setTransientState("packet.selection", selection);
      projections.set(source, { model: current, selection });
      const preview: MermaidPacketReactHostProps["onPreviewCommand"] = (
        command,
        basis = current.sourceDocument.source,
      ) => {
        if (context.getSource() !== current.sourceDocument.source)
          return packetNoChange(current, "conflict");
        const latest = context.getTransientState("packet.model") as
          MermaidPacketModel | undefined;
        return applyMermaidPacketFamilySourceCommand(
          latest?.sourceDocument.source === source ? latest : current,
          command,
          basis,
          readonly || context.getReadonly(),
          validSelection(
            current,
            context.getTransientState("packet.selection") as string | undefined,
          ),
        );
      };
      const body = context
        .getReactHost()
        ?.renderFamilyEditor(mermaidPacketRendererToken, {
          model: current,
          projectionModel: projected,
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
              context.setTransientState("packet.model", result.model);
              context.setTransientState(
                "packet.selection",
                result.selection ??
                  validSelection(
                    result.model,
                    context.getTransientState("packet.selection") as
                      string | undefined,
                  ),
              );
              projections.set(result.source, {
                model: result.model,
                selection: context.getTransientState("packet.selection") as
                  string | undefined,
              });
              context.commitSource(result.source, {
                preserveSourceBytes: true,
              });
            }
            return result;
          },
          onSelectionChange: (value) => {
            const latest =
              (context.getTransientState("packet.model") as
                MermaidPacketModel | undefined) ?? current;
            const selected = validSelection(projected ?? latest, value);
            context.setTransientState("packet.selection", selected);
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
