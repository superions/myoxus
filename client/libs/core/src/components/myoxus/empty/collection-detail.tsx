import { getArtworkUrl } from "@myoxus/theme/artwork";
import type { Collection } from "@myoxus/core/modules/collection";
import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { useI18n } from "@myoxus/i18n";
import { AllDocsIcon, FilterIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { Group } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { ActionButton } from "./action-button";
import { EmptyLayout } from "./layout";
import type { UniversalEmptyProps } from "./types";

export interface EmptyCollectionDetailProps extends UniversalEmptyProps {
  collection: Collection;
}

export const EmptyCollectionDetail = ({
  collection,
  ...props
}: EmptyCollectionDetailProps) => {
  const t = useI18n();

  return (
    <EmptyLayout
      illustrationLight={getArtworkUrl("collection-detail")}
      title={t["com.myoxus.empty.collection-detail.title"]()}
      description={t["com.myoxus.empty.collection-detail.description"]()}
      action={
        BUILD_CONFIG.isMobileEdition ? null : (
          <Actions collection={collection} />
        )
      }
      {...props}
    />
  );
};

const Actions = ({ collection }: { collection: Collection }) => {
  const t = useI18n();
  const workspaceDialogService = useService(WorkspaceDialogService);

  const openAddDocs = useCallback(() => {
    workspaceDialogService.open("collection-editor", {
      collectionId: collection.id,
      mode: "page",
    });
  }, [collection, workspaceDialogService]);

  const openAddRules = useCallback(() => {
    workspaceDialogService.open("collection-editor", {
      collectionId: collection.id,
      mode: "rule",
    });
  }, [collection, workspaceDialogService]);

  return (
    <Group
      data-myoxus-ui-role="empty-state-action-group"
      justify="center"
      wrap="wrap"
    >
      <ActionButton prefix={<AllDocsIcon />} onClick={openAddDocs}>
        {t["com.myoxus.empty.collection-detail.action.add-doc"]()}
      </ActionButton>

      <ActionButton prefix={<FilterIcon />} onClick={openAddRules}>
        {t["com.myoxus.empty.collection-detail.action.add-rule"]()}
      </ActionButton>
    </Group>
  );
};
