// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  applyJourneyCommands,
  type JourneyCommand,
  type MermaidJourneyModel,
} from "../../engine/journey/index.js";
export function applyMermaidJourneyFamilySourceCommand(
  model: MermaidJourneyModel,
  command: JourneyCommand | readonly JourneyCommand[],
  baseSource: string,
  readonly: boolean,
) {
  return applyJourneyCommands(
    model,
    Array.isArray(command) ? command : [command as JourneyCommand],
    { baseSource, readonly },
  );
}
