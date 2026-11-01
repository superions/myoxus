// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidArchitectureCommandResult } from "../../engine/architecture/index.js";
import { mermaidMessages } from "../../i18n.js";

export function architectureCommandDiagnosisMessage(
  result: MermaidArchitectureCommandResult,
) {
  return result.diagnosis
    ? mermaidMessages.architectureInvalidProperties()
    : null;
}
