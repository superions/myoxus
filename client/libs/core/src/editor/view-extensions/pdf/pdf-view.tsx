import { AttachmentEmbedPreview } from "@myoxus/core/editor/attachment-viewer/attachment-embed-preview";
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import { AttachmentEmbedConfigIdentifier } from "@virgultum/editor/blocks/attachment";
import { Bound } from "@virgultum/editor/global/gfx";
import {
  EMBED_CARD_HEIGHT,
  EMBED_CARD_WIDTH,
} from "@virgultum/editor/shared/consts";
import type { ExtensionType } from "@virgultum/editor/store";

export function patchForPDFEmbedView(
  mountPortal: MountReactPortal,
): ExtensionType {
  return {
    setup: (di) => {
      di.override(AttachmentEmbedConfigIdentifier("pdf"), () => ({
        name: "pdf",
        shouldShowStatus: true,
        check: (model, maxFileSize) =>
          model.props.type === "application/pdf" &&
          model.props.size <= maxFileSize,
        action: (model) => {
          const bound = Bound.deserialize(model.props.xywh);
          bound.w = EMBED_CARD_WIDTH.pdf;
          bound.h = EMBED_CARD_HEIGHT.pdf;
          model.store.updateBlock(model, {
            embed: true,
            style: "pdf",
            xywh: bound.serialize(),
          });
        },
        mount: (anchor, model) =>
          mountPortal(anchor, <AttachmentEmbedPreview model={model} />),
      }));
    },
  };
}
