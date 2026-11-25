// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  TextAttachmentPreview,
  textAttachmentFormat,
} from "@myoxus/core/editor/attachment-viewer/text/text-preview";
import type { MountReactPortal } from "@myoxus/core/editor/portal";
import { AttachmentEmbedConfigIdentifier } from "@virgultum/editor/blocks/attachment";
import type { ExtensionType } from "@virgultum/editor/store";

export function patchTextAttachmentPreview(
  mountPortal: MountReactPortal,
): ExtensionType {
  return {
    setup(di) {
      di.addImpl(AttachmentEmbedConfigIdentifier("text"), () => ({
        name: "text",
        check: (model, maxFileSize) =>
          !!textAttachmentFormat(model.props.name, model.props.type) &&
          model.props.size <= maxFileSize,
        action: (model) => {
          // Each explicit view switch is one native undo step, even in rapid succession.
          model.store.captureSync();
          model.store.updateBlock(model, { embed: true });
          model.store.captureSync();
        },
        mount: (anchor, model, blobUrl) =>
          mountPortal(
            anchor,
            <TextAttachmentPreview model={model} blobUrl={blobUrl} />,
          ),
      }));
    },
  };
}
