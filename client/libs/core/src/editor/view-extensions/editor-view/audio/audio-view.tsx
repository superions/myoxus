import { AttachmentEmbedPreview } from "@myoxus/core/editor/attachment-viewer/attachment-embed-preview";
import type { ReactToLit } from "@myoxus/lit-react";
import { AttachmentEmbedConfigIdentifier } from "@virgultum/editor/blocks/attachment";
import type { ExtensionType } from "@virgultum/store";

export function patchForAudioEmbedView(reactToLit: ReactToLit): ExtensionType {
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
        render: (model, _) =>
          reactToLit(<AttachmentEmbedPreview model={model} />, false),
      }));
    },
  };
}
