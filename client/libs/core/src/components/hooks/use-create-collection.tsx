import { CollectionService } from "@myoxus/core/modules/collection";
import { useI18n } from "@myoxus/i18n";
import { useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { MyoxusText, usePromptModal } from "@myoxus/ui-facade";
import { useCallback } from "react";

export const useCreateCollection = (onCreated: (id: string) => void) => {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const { openPromptModal } = usePromptModal();

  return useCallback(() => {
    openPromptModal({
      title: t["com.myoxus.editCollection.saveCollection"](),
      label: t["com.myoxus.editCollectionName.name"](),
      inputOptions: {
        placeholder: t["com.myoxus.editCollectionName.name.placeholder"](),
      },
      children: (
        <MyoxusText tone="secondary" typographySlot="body-small">
          {t["com.myoxus.editCollectionName.createTips"]()}
        </MyoxusText>
      ),
      confirmText: t["com.myoxus.editCollection.save"](),
      cancelText: t["com.myoxus.editCollection.button.cancel"](),
      confirmButtonOptions: {
        variant: "primary",
      },
      onConfirm(name) {
        const id = collectionService.createCollection({ name });
        track.$.navigationPanel.organize.createOrganizeItem({
          type: "collection",
        });
        onCreated(id);
      },
    });
  }, [collectionService, onCreated, openPromptModal, t]);
};
