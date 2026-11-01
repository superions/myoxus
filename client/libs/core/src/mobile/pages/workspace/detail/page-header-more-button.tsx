import { Guard } from "@myoxus/core/components/guard";
import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { useFavorite } from "@myoxus/core/editor/virgultum/doc-header/favorite";
import { DocInfoSheet } from "@myoxus/core/mobile/components";
import { MobileTocMenu } from "@myoxus/core/mobile/components/toc-menu";
import { DocService } from "@myoxus/core/modules/doc";
import { EditorService } from "@myoxus/core/modules/editor";
import { ViewService } from "@myoxus/core/modules/workbench/services/view";
import { preventDefault } from "@myoxus/core/utils";
import { useI18n } from "@myoxus/i18n";
import {
  DeleteIcon,
  InformationIcon,
  MoreHorizontalIcon,
  TocIcon,
} from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import {
  IconButton,
  MenuSeparator,
  MenuSub,
  MobileMenu,
  MobileMenuItem,
  notify,
  useConfirmModal,
} from "@myoxus/ui-facade";
import { useCallback, useEffect, useState } from "react";

import { JournalConflictsMenuItem } from "./menu/journal-conflicts";
import { JournalTodayActivityMenuItem } from "./menu/journal-today-activity";
import { EditorModeSwitch } from "./menu/mode-switch";

export const PageHeaderMenuButton = () => {
  const t = useI18n();

  const doc = useService(DocService).doc;
  const docId = doc?.id;

  const editorService = useService(EditorService);
  const editorContainer = useLiveData(editorService.editor.editorContainer$);

  const [open, setOpen] = useState(false);
  const location = useLiveData(useService(ViewService).view.location$);

  const isInTrash = useLiveData(
    editorService.editor.doc.meta$.map((meta) => meta.trash),
  );
  const title = useLiveData(editorService.editor.doc.title$);

  const { favorite, toggleFavorite } = useFavorite(docId);
  const { openConfirmModal } = useConfirmModal();

  const handleMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      track.$.header.docOptions.open();
    }
    setOpen(open);
  }, []);

  useEffect(() => {
    // when the location is changed, close the menu
    handleMenuOpenChange(false);
  }, [handleMenuOpenChange, location.pathname]);

  const handleToggleFavorite = useCallback(() => {
    track.$.header.docOptions.toggleFavorite();
    toggleFavorite();
  }, [toggleFavorite]);

  const handleMoveToTrash = useCallback(() => {
    if (!doc) {
      return;
    }
    openConfirmModal({
      title: t["com.myoxus.moveToTrash.title"](),
      description: t["com.myoxus.moveToTrash.confirmModal.description"]({
        title: doc.title$.value,
      }),
      confirmText: t["com.myoxus.moveToTrash.confirmModal.confirm"](),
      cancelText: t["com.myoxus.moveToTrash.confirmModal.cancel"](),
      confirmButtonOptions: {
        variant: "error",
      },
      onConfirm() {
        doc.moveToTrash();
        track.$.navigationPanel.docs.deleteDoc({
          control: "button",
        });
        notify({ title: t["com.myoxus.toastMessage.movedTrash"]() });
        // navigate back
        history.back();
      },
    });
  }, [doc, openConfirmModal, t]);

  const EditMenu = (
    <>
      <EditorModeSwitch />
      <JournalTodayActivityMenuItem suffix={<MenuSeparator />} />
      <MobileMenuItem
        data-testid="editor-option-menu-favorite"
        onSelect={handleToggleFavorite}
        prefixIcon={<IsFavoriteIcon favorite={favorite} />}
      >
        {favorite
          ? t["com.myoxus.favoritePageOperation.remove"]()
          : t["com.myoxus.favoritePageOperation.add"]()}
      </MobileMenuItem>
      <MenuSeparator />
      <MenuSub
        triggerOptions={{
          prefixIcon: <InformationIcon />,
          onClick: preventDefault,
        }}
        title={title ?? t["unnamed"]()}
        items={<DocInfoSheet docId={docId} />}
      >
        <span>{t["com.myoxus.page-properties.page-info.view"]()}</span>
      </MenuSub>
      <MobileMenu
        title={t["com.myoxus.header.menu.toc"]()}
        items={<MobileTocMenu editor={editorContainer?.host ?? null} />}
      >
        <MobileMenuItem prefixIcon={<TocIcon />} onClick={preventDefault}>
          <span>{t["com.myoxus.header.option.view-toc"]()}</span>
        </MobileMenuItem>
      </MobileMenu>
      <JournalConflictsMenuItem />
      <Guard docId={docId} permission="Doc_Trash">
        {(canMoveToTrash) => (
          <MobileMenuItem
            prefixIcon={<DeleteIcon />}
            type="danger"
            disabled={!canMoveToTrash}
            onSelect={handleMoveToTrash}
          >
            {t["com.myoxus.moveToTrash.title"]()}
          </MobileMenuItem>
        )}
      </Guard>
    </>
  );
  if (isInTrash) {
    return null;
  }
  return (
    <MobileMenu
      items={EditMenu}
      contentOptions={{
        align: "center",
      }}
      rootOptions={{
        open,
        onOpenChange: handleMenuOpenChange,
      }}
    >
      <IconButton
        data-testid="detail-page-header-more-button"
        icon={<MoreHorizontalIcon />}
      />
    </MobileMenu>
  );
};
