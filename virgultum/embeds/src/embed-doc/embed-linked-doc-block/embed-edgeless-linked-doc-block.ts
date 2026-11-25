import {
  createEmbedEdgelessBlockInteraction,
  toEdgelessEmbedBlock,
} from "../../embed/index";
import {
  EdgelessCRUDIdentifier,
  reassociateConnectorsCommand,
} from "@virgultum/canvas-runtime/surface";
import { Bound } from "@virgultum/core/primitives/gfx";
import { EmbedLinkedDocBlockSchema } from "@virgultum/core/models";
import { EMBED_CARD_HEIGHT, EMBED_CARD_WIDTH } from "@virgultum/core/consts";
import {
  cloneReferenceInfoWithoutAliases,
  isNewTabTrigger,
  isNewViewTrigger,
} from "@virgultum/core/utils";

import { EmbedLinkedDocBlockComponent } from "./embed-linked-doc-block.js";

export class EmbedEdgelessLinkedDocBlockComponent extends toEdgelessEmbedBlock(
  EmbedLinkedDocBlockComponent,
) {
  override convertToEmbed = () => {
    const { caption, xywh } = this.model.props;
    const { store, id } = this.model;

    const style = "syncedDoc";
    const bound = Bound.deserialize(xywh);
    bound.w = EMBED_CARD_WIDTH[style];
    bound.h = EMBED_CARD_HEIGHT[style];

    const { addBlock } = this.std.get(EdgelessCRUDIdentifier);
    const surface = this.gfx.surface ?? undefined;
    const newId = addBlock(
      "myoxus:embed-synced-doc",
      {
        xywh: bound.serialize(),
        caption,
        ...cloneReferenceInfoWithoutAliases(this.referenceInfo$.peek()),
      },
      surface,
    );

    this.std.command.exec(reassociateConnectorsCommand, {
      oldId: id,
      newId,
    });

    this.gfx.selection.set({
      editing: false,
      elements: [newId],
    });

    store.deleteBlock(this.model);
  };

  protected override _handleClick(evt: MouseEvent): void {
    if (isNewTabTrigger(evt)) {
      this.open({ openMode: "open-in-new-tab", event: evt });
    } else if (isNewViewTrigger(evt)) {
      this.open({ openMode: "open-in-new-view", event: evt });
    }
  }
}

export const EmbedLinkedDocInteraction = createEmbedEdgelessBlockInteraction(
  EmbedLinkedDocBlockSchema.model.flavour,
);
