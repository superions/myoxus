// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

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
  returnFocusRef,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["collection-editor"]>) => {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const collection = useLiveData(collectionService.collection$(collectionId));
  const info = useLiveData(collection?.info$);

  const [open, setOpen] = useState(true);
  const [selectedMode, setSelectedMode] = useState<
    EditCollectionMode | undefined
  >(mode);

  const requestClose = useCallback(() => {
    setOpen(false);
  }, []);

  const handleConfirm = useCallback(
    (updated: CollectionInfo) => {
      collectionService.updateCollection(updated.id, updated);
      setOpen(false);
    },
    [collectionService],
  );

  if (!collection || !info) {
    return null;
  }

  const activeMode: EditCollectionMode =
    selectedMode ?? (info.rules.filters.length === 0 ? "page" : "rule");

  return (
    <Modal
      open={open}
      returnFocusRef={returnFocusRef}
      onExitTransitionEnd={() => close()}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) requestClose();
      }}
      title={info.name?.trim() || t["Untitled"]()}
      width="xl"
      height={activeMode === "rule" ? "80%" : undefined}
      contentOptions={
        activeMode === "rule" ? { bodyOverflow: "hidden" } : undefined
      }
    >
      <EditCollection
        init={info}
        mode={activeMode}
        onConfirmText={t["com.myoxus.editCollection.save"]()}
        onModeChange={setSelectedMode}
        onCancel={requestClose}
        onConfirm={handleConfirm}
      />
    </Modal>
  );
};
