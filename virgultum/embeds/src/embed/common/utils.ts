import { EmbedOptionProvider } from "@virgultum/core/services";
import type { BlockStdScope } from "@virgultum/core/runtime";

export function canEmbedAsEmbedBlock(std: BlockStdScope, url: string) {
  const options = std.get(EmbedOptionProvider).getEmbedBlockOptions(url);
  return options?.viewType === "embed";
}
