// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { BlockViewExtension } from "@virgultum/editor/std";
import type { ExtensionType } from "@virgultum/editor/store";

export const AIChatBlockSpec: ExtensionType[] = [
  BlockViewExtension("myoxus:embed-ai-chat", (model) => {
    const parent = model.store.getParent(model.id);
    return parent?.flavour === "myoxus:surface"
      ? "myoxus-edgeless-ai-chat"
      : "myoxus-ai-chat";
  }),
];
