// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EdgelessCopilotWidget,
  MYOXUS_EDGELESS_COPILOT_WIDGET,
} from "../widgets/edgeless-copilot";
import { interactiveEditorTags } from "./registry";

const registeredRegistries = new WeakSet<CustomElementRegistry>();

export function registerAIEditorEffects(): void {
  const registry = customElements;
  if (registeredRegistries.has(registry)) return;

  const constructors = {
    [MYOXUS_EDGELESS_COPILOT_WIDGET]: EdgelessCopilotWidget,
  } satisfies Record<
    (typeof interactiveEditorTags)[number],
    CustomElementConstructor
  >;

  for (const tag of interactiveEditorTags) {
    registry.define(tag, constructors[tag]);
  }
  registeredRegistries.add(registry);
}
