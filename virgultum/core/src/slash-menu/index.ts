// SPDX-License-Identifier: MIT

import { createIdentifier } from "../primitives/di";
import type { ExtensionType } from "../store";
import type { SlashMenuConfig } from "./types";

export type * from "./types";

// This DI identity is shared with the existing widget; only declarations live here.
export const SlashMenuConfigIdentifier = createIdentifier<SlashMenuConfig>(
  "myoxus-slash-menu-widget-config",
);

export function SlashMenuConfigExtension(
  id: string,
  config: SlashMenuConfig,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(SlashMenuConfigIdentifier(id), config);
    },
  };
}
