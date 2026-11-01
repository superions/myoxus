import { insertEmbedCard } from "@virgultum/block-embed";
import type { EmbedCardStyle, ReferenceParams } from "@virgultum/model";
import type { Command } from "@virgultum/std";

export type LinkableFlavour =
  | "myoxus:bookmark"
  | "myoxus:embed-linked-doc"
  | "myoxus:embed-synced-doc"
  | "myoxus:embed-iframe"
  | "myoxus:embed-figma"
  | "myoxus:embed-github"
  | "myoxus:embed-loom"
  | "myoxus:embed-youtube";

export type InsertedLinkType = {
  flavour: LinkableFlavour;
} | null;

export const insertEmbedLinkedDocCommand: Command<
  {
    docId: string;
    params?: ReferenceParams;
  },
  { blockId: string }
> = (ctx, next) => {
  const { docId, params, std } = ctx;
  const flavour = "myoxus:embed-linked-doc";
  const targetStyle: EmbedCardStyle = "vertical";
  const props: Record<string, unknown> = { pageId: docId };
  if (params) props.params = params;
  const blockId = insertEmbedCard(std, { flavour, targetStyle, props });
  if (!blockId) return;
  next({ blockId });
};
