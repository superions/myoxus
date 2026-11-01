// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../i18n.js";
import { parseMermaidPacketSource } from "./parser.js";
import type { MermaidPacketModel } from "./model.js";

export function packetSourceDiagnostic(model: MermaidPacketModel) {
  const diagnostic = model.diagnostics[0];
  if (diagnostic)
    return messages.packetDiagnosticLine(diagnostic.line, diagnostic.message);
  const issue = model.issues[0];
  if (issue)
    return issue.code === "invalid-range"
      ? messages.packetDiagnosticLine(
          issue.line ?? 1,
          messages.packetInvalidRange(issue.startBit, issue.endBit),
        )
      : messages.packetDiagnosticLine(
          issue.line ?? 1,
          messages.packetNoncontiguous(
            issue.expectedStart ?? issue.startBit,
            model.fields.find((f) => issue.fieldIds.includes(f.id))?.startBit ??
              issue.startBit,
          ),
        );
  return null;
}
export function getMermaidPacketSourceDiagnostic(source: string) {
  const model = parseMermaidPacketSource(source);
  return model
    ? (packetSourceDiagnostic(model) ?? messages.packetSourceFidelity())
    : messages.packetMissingHeader();
}
