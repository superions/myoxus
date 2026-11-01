import { ConfigExtensionFactory } from "@virgultum/std";

import type { ToolbarMoreMenuConfig } from "./types";

export const ToolbarMoreMenuConfigExtension = ConfigExtensionFactory<
  Partial<ToolbarMoreMenuConfig>
>("myoxus-toolbar-more-menu");
