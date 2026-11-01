import { getArtworkUrl } from "@myoxus/theme/artwork";
import { useCreateCollection } from "@myoxus/core/components/hooks/use-create-collection";
import { useNavigateHelper } from "@myoxus/core/components/hooks/use-navigate-helper";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { ViewLayersIcon } from "@myoxus/icons/react";
import { useService } from "@myoxus/infra";
import { useCallback } from "react";

import { ActionButton } from "./action-button";
import { EmptyLayout } from "./layout";
import type { UniversalEmptyProps } from "./types";

export const EmptyCollections = (props: UniversalEmptyProps) => {
  const t = useI18n();
  const currentWorkspace = useService(WorkspaceService).workspace;

  const navigateHelper = useNavigateHelper();

  const showAction = true;

  const handleCollectionCreated = useCallback(
    (id: string) => navigateHelper.jumpToCollection(currentWorkspace.id, id),
    [currentWorkspace.id, navigateHelper],
  );
  const handleCreateCollection = useCreateCollection(handleCollectionCreated);

  return (
    <EmptyLayout
      illustrationLight={getArtworkUrl("collections")}
      title={t["com.myoxus.collections.empty.message"]()}
      description={t["com.myoxus.collection.emptyCollectionDescription"]()}
      action={
        showAction ? (
          <ActionButton
            prefix={<ViewLayersIcon />}
            onClick={handleCreateCollection}
          >
            {t["com.myoxus.empty.collections.action.new-collection"]()}
          </ActionButton>
        ) : null
      }
      {...props}
    />
  );
};
