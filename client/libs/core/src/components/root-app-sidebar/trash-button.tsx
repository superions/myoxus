import { useDocumentOperations } from "@myoxus/core/components/hooks/myoxus/use-document-operations";
import { MenuLinkItem } from "@myoxus/core/modules/app-sidebar/views";
import { DocsService } from "@myoxus/core/modules/doc";
import { GlobalContextService } from "@myoxus/core/modules/global-context";
import { GuardService } from "@myoxus/core/modules/permissions";
import type { MyoxusDNDData } from "@myoxus/core/types/dnd";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { TrashIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { notify, useConfirmModal, useDropTarget } from "@myoxus/ui-facade";

export const TrashButton = () => {
  const t = useI18n();
  const docsService = useService(DocsService);
  const { openConfirmModal } = useConfirmModal();
  const globalContextService = useService(GlobalContextService);
  const trashActive = useLiveData(globalContextService.globalContext.isTrash.$);
  const guardService = useService(GuardService);
  const { moveManyToTrash } = useDocumentOperations();

  const { dropTargetRef, draggedOver } = useDropTarget<MyoxusDNDData>(
    () => ({
      data: {
        at: "app-sidebar:trash",
      },
      canDrop(data) {
        return data.source.data.entity?.type === "doc";
      },
      onDrop(data) {
        if (data.source.data.entity?.type === "doc") {
          const sourceDocIds =
            data.source.data.selection?.type === "doc"
              ? data.source.data.selection.ids
              : [data.source.data.entity.id];
          const docIds = Array.from(new Set(sourceDocIds)).filter(Boolean);
          const docRecords = docIds
            .map((docId) => docsService.list.doc$(docId).value)
            .filter((docRecord) => docRecord !== undefined);

          if (docRecords.length === 0) {
            return;
          }

          const multiple = docRecords.length > 1;
          openConfirmModal({
            title: multiple
              ? t["com.myoxus.moveToTrash.confirmModal.title.multiple"]({
                  number: docRecords.length.toString(),
                })
              : t["com.myoxus.moveToTrash.confirmModal.title"](),
            description: multiple
              ? t["com.myoxus.moveToTrash.confirmModal.description.multiple"]({
                  number: docRecords.length.toString(),
                })
              : t["com.myoxus.moveToTrash.confirmModal.description"]({
                  title: docRecords[0].title$.value || t["Untitled"](),
                }),
            confirmText: t.Delete(),
            confirmButtonOptions: {
              variant: "error",
            },
            async onConfirm() {
              try {
                for (const docRecord of docRecords) {
                  const canTrash = await guardService.can(
                    "Doc_Trash",
                    docRecord.id,
                  );
                  if (!canTrash) {
                    notify({ title: t["com.myoxus.no-permission"]() });
                    return;
                  }
                }
                await moveManyToTrash(docRecords);
              } catch (error) {
                console.error(error);
                const userFriendlyError = UserFriendlyError.fromAny(error);
                notify({
                  title: t[`error.${userFriendlyError.name}`](
                    userFriendlyError.data,
                  ),
                });
              }
            },
          });
        }
      },
      allowExternal: true,
    }),
    [docsService.list, guardService, moveManyToTrash, openConfirmModal, t],
  );

  return (
    <MenuLinkItem
      ref={dropTargetRef}
      icon={<TrashIcon />}
      active={trashActive || draggedOver}
      tone="danger"
      to={"/trash"}
    >
      <span data-testid="trash-page">
        {t["com.myoxus.workspaceSubPath.trash"]()}
      </span>
    </MenuLinkItem>
  );
};
