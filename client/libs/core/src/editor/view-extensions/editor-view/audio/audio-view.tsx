import { AttachmentEmbedPreview } from "@myoxus/core/editor/attachment-viewer/attachment-embed-preview";
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import { AttachmentEmbedConfigIdentifier } from "@virgultum/editor/blocks/attachment";
import type { ExtensionType } from "@virgultum/core/store";

export function patchForAudioEmbedView(
  mountPortal: MountReactPortal,
): ExtensionType {
  return {
    setup: (di) => {
      // do not show audio block on mobile
      if (BUILD_CONFIG.isMobileEdition) {
        return;
      }
      di.override(AttachmentEmbedConfigIdentifier("audio"), () => ({
        name: "audio",
        check: (model, maxFileSize) =>
          model.props.type.startsWith("audio/") &&
          model.props.size <= maxFileSize,
        mount: (anchor, model) =>
          mountPortal(anchor, <AttachmentEmbedPreview model={model} />),
      }));
    },
  };
}
