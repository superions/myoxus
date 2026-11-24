import { toDocSearchParams } from "@myoxus/core/modules/navigation";
import { ServerService } from "@myoxus/core/modules/server";
import {
  copyEditorLink,
  copyTextToClipboard,
} from "@myoxus/core/utils/clipboard";
import { I18n, useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import type { SerializedXYWH } from "@virgultum/editor/global/gfx";
import { type DocMode } from "@virgultum/editor/model";
import { useCallback } from "react";

export type UseSharingUrl = {
  workspaceId: string;
  pageId: string;
  mode?: DocMode;
  blockSelection?: "section" | "subtree";
  blockIds?: string[];
  elementIds?: string[];
  xywh?: SerializedXYWH; // not needed currently
};

/**
 * To generate a url like
 *
 * https://workspace.example/workspace/workspaceId/docId?mode=DocMode&elementIds=selectedElementIds&blockIds=selectedBlockIds
 */
export const generateUrl = ({
  baseUrl,
  workspaceId,
  pageId,
  blockIds,
  blockSelection,
  elementIds,
  mode,
  xywh, // not needed currently
}: UseSharingUrl & { baseUrl: string }) => {
  try {
    const url = new URL(`/workspace/${workspaceId}/${pageId}`, baseUrl);
    const search = toDocSearchParams({
      mode,
      blockIds,
      blockSelection,
      elementIds,
      xywh,
    });
    if (search?.size) url.search = search.toString();
    return url.toString();
  } catch (err) {
    console.error(err);
    return undefined;
  }
};

/** Toolbar links keep the editor HTML format in both document views. */
export async function copyEditorBlockLink(
  options: UseSharingUrl & { baseUrl: string },
  type: string,
  clipboard?: Parameters<typeof copyEditorLink>[1],
) {
  const url = generateUrl(options);
  if (!url) return;
  if (await copyEditorLink(url, clipboard))
    notify.success({ title: I18n["Copied link to clipboard"]() });
  track.doc.editor.toolbar.copyBlockToLink({ type });
}

const getShareLinkType = ({
  mode,
  blockIds,
  elementIds,
}: {
  mode?: DocMode;
  blockIds?: string[];
  elementIds?: string[];
}) => {
  if (mode === "page") {
    return "doc";
  } else if (mode === "edgeless") {
    return "whiteboard";
  } else if (blockIds && blockIds.length > 0) {
    return "block";
  } else if (elementIds && elementIds.length > 0) {
    return "element";
  } else {
    return "default";
  }
};

export const useSharingUrl = ({ workspaceId, pageId }: UseSharingUrl) => {
  const t = useI18n();
  const serverService = useService(ServerService);

  const onClickCopyLink = useCallback(
    (mode?: DocMode, blockIds?: string[], elementIds?: string[]) => {
      const sharingUrl = generateUrl({
        baseUrl: serverService.server.baseUrl,
        workspaceId,
        pageId,
        blockIds,
        elementIds,
        mode, // if view is not provided, use the current view
      });
      const type = getShareLinkType({
        mode,
        blockIds,
        elementIds,
      });
      if (sharingUrl) {
        copyTextToClipboard(sharingUrl)
          .then((success) => {
            if (success) {
              notify.success({ title: t["Copied link to clipboard"]() });
            }
          })
          .catch((err) => {
            console.error(err);
          });
        track.$.sharePanel.$.copyShareLink({ type });
      } else {
        notify.error({ title: "Network not available" });
      }
    },
    [pageId, serverService, t, workspaceId],
  );

  return {
    onClickCopyLink,
  };
};
