import { useAsyncCallback } from "../../hooks/myoxus-async-hooks";
import { DocService } from "@myoxus/core/modules/doc";
import { useI18n } from "@myoxus/i18n";
import { ArchiveRestoreIcon, DeleteIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import {
  ConfirmModal,
  DialogFooter,
  DialogFooterActions,
  IconButton,
  MyoxusText,
  notify,
} from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { useDocumentOperations } from "../../../components/hooks/myoxus/use-document-operations";
import { useNavigateHelper } from "../../../components/hooks/use-navigate-helper";

export const TrashPageFooter = () => {
  const doc = useService(DocService).doc;
  const workspace = doc.workspace;
  const t = useI18n();
  const { jumpToPage } = useNavigateHelper();
  const { permanentlyDeletePage, restoreFromTrash } = useDocumentOperations();
  const [open, setOpen] = useState(false);
  const hintText = t["com.myoxus.cmdk.editor.trash-footer-hint"]();

  const onRestore = useAsyncCallback(async () => {
    await restoreFromTrash(doc.id);
    notify({
      title: t["com.myoxus.toastMessage.restored"]({
        title: doc.meta$.value.title || "Untitled",
      }),
    });
  }, [doc.id, doc.meta$.value.title, restoreFromTrash, t]);

  const onConfirmDelete = useCallback(async () => {
    jumpToPage(workspace.id, "all");
    await permanentlyDeletePage(doc.id);
    notify({ title: t["com.myoxus.toastMessage.permanentlyDeleted"]() });
  }, [jumpToPage, workspace.id, permanentlyDeletePage, doc.id, t]);

  const onDelete = useCallback(() => {
    setOpen(true);
  }, []);

  return (
    <DialogFooter data-myoxus-ui-role="trash-page-footer">
      <MyoxusText
        data-myoxus-ui-role="trash-page-footer-hint"
        tone="secondary"
        truncate
        typographySlot="card-title"
      >
        {hintText}
      </MyoxusText>
      <DialogFooterActions data-myoxus-ui-role="trash-page-footer-actions">
        <IconButton
          tooltip={t["com.myoxus.trashOperation.restoreIt"]()}
          data-testid="page-restore-button"
          variant="primary"
          onClick={onRestore}
          icon={<ArchiveRestoreIcon />}
        />
        <IconButton
          tooltip={t["com.myoxus.trashOperation.deletePermanently"]()}
          variant="error"
          onClick={onDelete}
          icon={<DeleteIcon />}
        />
      </DialogFooterActions>
      <ConfirmModal
        title={t["com.myoxus.trashOperation.delete.title"]()}
        cancelText={t["com.myoxus.confirmModal.button.cancel"]()}
        description={t["com.myoxus.trashOperation.delete.description"]()}
        confirmText={t["com.myoxus.trashOperation.delete"]()}
        confirmButtonOptions={{
          variant: "error",
        }}
        open={open}
        onConfirm={onConfirmDelete}
        onOpenChange={setOpen}
      />
    </DialogFooter>
  );
};
