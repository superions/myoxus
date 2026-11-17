import { insertEmbedCard } from "../../embed/index";
import type { EmbedCardStyle } from "@virgultum/core/models";
import { EmbedOptionProvider } from "@virgultum/core/services";
import type { Command } from "@virgultum/core/runtime";

export const insertBookmarkCommand: Command<
  { url: string },
  { blockId: string; flavour: string }
> = (ctx, next) => {
  const { url, std } = ctx;
  const embedOptions = std.get(EmbedOptionProvider).getEmbedBlockOptions(url);

  let flavour = "myoxus:bookmark";
  let targetStyle: EmbedCardStyle = "vertical";
  const props: Record<string, unknown> = { url };
  if (embedOptions) {
    flavour = embedOptions.flavour;
    targetStyle = embedOptions.styles[0];
  }
  const blockId = insertEmbedCard(std, { flavour, targetStyle, props });
  if (!blockId) return;
  next({ blockId, flavour });
};
