import { insertEmbedCard } from "../../../embed/index";
import type { EmbedCardStyle, ReferenceParams } from "@virgultum/core/models";
import type { Command } from "@virgultum/core/runtime";

export const insertEmbedSyncedDocCommand: Command<
  {
    docId: string;
    params?: ReferenceParams;
  },
  { blockId: string }
> = (ctx, next) => {
  const { docId, params, std } = ctx;
  const flavour = "myoxus:embed-synced-doc";
  const targetStyle: EmbedCardStyle = "syncedDoc";
  const props: Record<string, unknown> = { pageId: docId };
  if (params) props.params = params;
  const blockId = insertEmbedCard(std, { flavour, targetStyle, props });
  if (!blockId) return;
  next({ blockId });
};
