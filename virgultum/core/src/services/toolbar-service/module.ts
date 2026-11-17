import type { BlockFlavourIdentifier } from "../../runtime/index";

import type { ToolbarModuleConfig } from "./config";

export type ToolbarModule = {
  readonly id: ReturnType<typeof BlockFlavourIdentifier>;

  readonly config: ToolbarModuleConfig;
};
