import type { BlockModel } from "@virgultum/store";

export type DocRemoteSelectionConfig = {
  blockSelectionBackgroundTransparent: (block: BlockModel) => boolean;
};
