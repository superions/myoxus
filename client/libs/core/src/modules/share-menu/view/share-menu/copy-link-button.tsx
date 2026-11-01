import {
  getSelectedNodes,
  useSharingUrl,
} from "@myoxus/core/components/hooks/myoxus/use-share-url";
import { EditorService } from "@myoxus/core/modules/editor";
import { useI18n } from "@myoxus/i18n";
import { BlockIcon, EdgelessIcon, PageIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  MenuItem,
  SplitMenuButton,
  useResponsiveElementSize,
} from "@myoxus/ui-facade";
import type { DocMode } from "@virgultum/editor/model";
import { useCallback, useMemo } from "react";

export const CopyLinkButton = ({
  workspaceId,
  secondary,
}: {
  secondary?: boolean;
  workspaceId: string;
}) => {
  const t = useI18n();

  const editor = useService(EditorService).editor;
  const currentMode = useLiveData(editor.mode$);
  const editorContainer = useLiveData(editor.editorContainer$);
  const { ref: containerRef, width: containerWidth } =
    useResponsiveElementSize<HTMLDivElement>();
  const showDesktopShortcut =
    BUILD_CONFIG.isDesktopEdition &&
    // Keep the shortcut visible before the first measurement to avoid a
    // hydration flicker, then let the facade-owned measurement decide.
    (containerWidth === 0 || containerWidth > 320);

  const { blockIds, elementIds } = useMemo(
    () => getSelectedNodes(editorContainer?.host || null, currentMode),
    [editorContainer, currentMode],
  );
  const { onClickCopyLink } = useSharingUrl({
    workspaceId,
    pageId: editor.doc.id,
  });

  const onCopyPageLink = useCallback(() => {
    onClickCopyLink("page" as DocMode);
  }, [onClickCopyLink]);
  const onCopyEdgelessLink = useCallback(() => {
    onClickCopyLink("edgeless" as DocMode);
  }, [onClickCopyLink]);
  const onCopyBlockLink = useCallback(() => {
    onClickCopyLink(currentMode, blockIds, elementIds);
  }, [onClickCopyLink, currentMode, blockIds, elementIds]);

  const onCopyLink = useCallback(() => {
    onClickCopyLink();
  }, [onClickCopyLink]);

  return (
    <SplitMenuButton
      ref={containerRef}
      label={t["com.myoxus.share-menu.copy"]()}
      menuItems={
        <>
          <MenuItem
            prefixIcon={<PageIcon />}
            onSelect={onCopyPageLink}
            data-testid="share-link-menu-copy-page"
          >
            {t["com.myoxus.share-menu.copy.page"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<EdgelessIcon />}
            onSelect={onCopyEdgelessLink}
            data-testid="share-link-menu-copy-edgeless"
          >
            {t["com.myoxus.share-menu.copy.edgeless"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<BlockIcon />}
            onSelect={onCopyBlockLink}
            disabled={blockIds.length + elementIds.length === 0}
          >
            {t["com.myoxus.share-menu.copy.block"]()}
          </MenuItem>
        </>
      }
      menuTestId="share-menu-copy-link-button"
      onClick={onCopyLink}
      shortcut={
        showDesktopShortcut
          ? environment.isMacOs
            ? "⌘ + ⌥ + C"
            : "Ctrl + Shift + C"
          : undefined
      }
      spacing={secondary ? "section" : "none"}
      variant={secondary ? "secondary" : "primary"}
    />
  );
};
