import {
  type CollectionInfo,
  CollectionService,
} from "@myoxus/core/modules/collection";
import type { DialogComponentProps } from "@myoxus/core/modules/dialogs";
import type { WORKSPACE_DIALOG_SCHEMA } from "@myoxus/core/modules/dialogs/constant";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { Modal } from "@myoxus/ui-facade";
import { useCallback, useState } from "react";

import { EditCollection, type EditCollectionMode } from "./edit-collection";

export const CollectionEditorDialog = ({
  close,
  collectionId,
  mode,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["collection-editor"]>) => {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const collection = useLiveData(collectionService.collection$(collectionId));
  const onConfirmOnCollection = useCallback(
    (collection: CollectionInfo) => {
      collectionService.updateCollection(collection.id, collection);
      close();
    },
    [close, collectionService],
  );
  const info = useLiveData(collection?.info$);
  const [selectedMode, setSelectedMode] = useState<
    EditCollectionMode | undefined
  >(mode);
  const onCancel = useCallback(() => {
    close();
  }, [close]);

  if (!collection || !info) {
    return null;
  }
  const activeMode =
    selectedMode ?? (info.rules.filters.length === 0 ? "page" : "rule");

  return (
    <Modal
      open
      onOpenChange={onCancel}
      title={info.name?.trim() || t["Untitled"]()}
      width="xl"
      height={activeMode === "rule" ? "80%" : undefined}
      contentOptions={
        activeMode === "rule" ? { bodyOverflow: "hidden" } : undefined
      }
    >
      <EditCollection
        onConfirmText={t["com.myoxus.editCollection.save"]()}
        init={info}
        mode={activeMode}
        onModeChange={setSelectedMode}
        onCancel={onCancel}
        onConfirm={onConfirmOnCollection}
      />
    </Modal>
  );
};
