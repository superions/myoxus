import { CollectionService } from "@myoxus/core/modules/collection";
import type {
  DialogComponentProps,
  WORKSPACE_DIALOG_SCHEMA,
} from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { ViewLayersIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import { Modal } from "@myoxus/ui-facade";
import { useMemo } from "react";

import { GenericSelector } from "./generic-selector";

export const CollectionSelectorDialog = ({
  close,
  init,
  onBeforeConfirm,
}: DialogComponentProps<WORKSPACE_DIALOG_SCHEMA["collection-selector"]>) => {
  const t = useI18n();
  const collectionService = useService(CollectionService);
  const collections = useLiveData(collectionService.collectionMetas$);

  const list = useMemo(() => {
    return collections.map((collection) => ({
      id: collection.id,
      icon: <ViewLayersIcon />,
      label: collection.name,
    }));
  }, [collections]);

  return (
    <Modal
      open
      onOpenChange={() => close()}
      withoutCloseButton
      fullScreen
      contentOptions={{
        style: {
          background: cssVar("backgroundSecondaryColor"),
          padding: 0,
        },
      }}
    >
      <GenericSelector
        onBack={close}
        onConfirm={close}
        onBeforeConfirm={onBeforeConfirm}
        initial={init}
        data={list}
        typeName={t[`com.myoxus.m.selector.type-collection`]()}
      />
    </Modal>
  );
};
