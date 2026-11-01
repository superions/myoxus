// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  parseMermaidPacketSource,
  packetSourceDiagnostic,
  type MermaidPacketModel,
} from "../../engine/packet/index.js";
import { mermaidMessages as messages } from "../../i18n.js";
import type { MermaidFamilyModule } from "../contracts.js";
import { mermaidPacketActions } from "./edgeless-actions.js";
export function packetFamilyDiagnostics(model: MermaidPacketModel) {
  const message = packetSourceDiagnostic(model);
  return message
    ? [{ code: "packet.source", message, severity: "error" as const }]
    : [];
}
export const mermaidPacketFamily: MermaidFamilyModule<
  MermaidPacketModel,
  MermaidPacketModel
> = {
  id: "packet",
  diagramTypes: ["packet"],
  inspector: [],
  toolbar: mermaidPacketActions,
  commands: mermaidPacketActions.map((action) => ({
    id: action.commandId,
    label: action.label,
    role: action.commandId === "packet.add" ? "create" : "edit",
  })),
  parseSource: (source, type) => {
    const model = type === "packet" ? parseMermaidPacketSource(source) : null;
    return {
      source,
      diagramType: "packet",
      model,
      diagnostics: model
        ? packetFamilyDiagnostics(model)
        : [
            {
              code: "packet.unsupported-diagram-type",
              message: messages.packetMissingHeader(),
              severity: "error" as const,
            },
          ],
    };
  },
  applyVisualToSource: (_model, source) => ({
    source,
    diagnostics: [
      {
        code: "packet.command-required",
        message: messages.visualMutationOwnerUnavailable("Packet"),
        severity: "error",
      },
    ],
  }),
  materializeFrame: () => undefined,
  readFrame: () => null,
  toVisualModel: (parsed) =>
    parsed.model
      ? {
          kind: "editable",
          visualModel: parsed.model,
          diagnostics: parsed.diagnostics,
        }
      : {
          kind: "source-only",
          reason: messages.mmdImportInvalid(),
          diagnostics: parsed.diagnostics,
        },
};
