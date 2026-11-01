import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { notify, useConfirmModal } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { TagService } from "../service/tag";

/** Confirms and applies the reversible server-owned tag archive lifecycle. */
export const useArchiveTagConfirmModal = (options?: {
  archiveTag?: (tagId: string) => Promise<unknown>;
  onError?: (error: unknown) => void;
}) => {
  const { openConfirmModal } = useConfirmModal();

  const t = useI18n();
  const tagService = useService(TagService);
  const confirm = useCallback(
    (tagIdsToArchive: string[]) => {
      let closed = false;
      let archiving = false;
      const { resolve, promise } = Promise.withResolvers<boolean>();
      const settle = (state: boolean) => {
        if (!closed) {
          closed = true;
          resolve(state);
        }
      };
      const archiveTags = async () => {
        archiving = true;
        try {
          await Promise.all(
            tagIdsToArchive.map((tagId) =>
              options?.archiveTag
                ? options.archiveTag(tagId)
                : tagService.tagList.archiveTag(tagId),
            ),
          );
          notify({
            title: t["com.myoxus.tags.status.archived"](),
          });
          settle(true);
        } catch (error) {
          if (options?.onError) {
            options.onError(error);
          } else {
            notify.error({ title: t["com.myoxus.common.operation-failed"]() });
          }
          settle(false);
        }
      };
      openConfirmModal({
        title: t["com.myoxus.tags.archive.confirm.title"](),
        description: t["com.myoxus.tags.archive.confirm.description"](),
        confirmText: t["com.myoxus.tags.archive.action"](),
        cancelText: t["com.myoxus.confirmModal.button.cancel"](),
        onConfirm: () => {
          void archiveTags();
        },
        onCancel: () => {
          settle(false);
        },
        onOpenChange: (state) => {
          if (!state && !archiving) settle(false);
        },
      });
      return promise;
    },
    [openConfirmModal, options, t, tagService.tagList],
  );

  return confirm;
};
