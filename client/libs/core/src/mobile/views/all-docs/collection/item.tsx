import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import type { CollectionMeta } from "@myoxus/core/modules/collection";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { WorkbenchLink } from "@myoxus/core/modules/workbench";
import { ViewLayersIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  IconButton,
  SurfaceListItem,
  SurfaceListItemFrame,
  SurfaceListItemIcon,
  SurfaceListSpacer,
  SurfaceListText,
} from "@myoxus/ui-facade";
import { type MouseEvent, useCallback } from "react";

export const CollectionListItem = ({ meta }: { meta: CollectionMeta }) => {
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);

  const isFavorite = useLiveData(favAdapter.isFavorite$(meta.id, "collection"));

  const toggle = useCallback(
    (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      favAdapter.toggle(meta.id, "collection");
    },
    [favAdapter, meta.id],
  );

  return (
    <SurfaceListItemFrame
      component={WorkbenchLink}
      data-myoxus-ui-role="mobile-collection-list-link"
      to={`/collection/${meta.id}`}
    >
      <SurfaceListItem
        component="div"
        fullWidth
        interactive
        layout="row"
        role="presentation"
      >
        <SurfaceListItemIcon size="md">
          <ViewLayersIcon />
        </SurfaceListItemIcon>
        <SurfaceListText kind="title">{meta.title}</SurfaceListText>
        <SurfaceListSpacer />
        <IconButton
          aria-label="favorite collection"
          aria-pressed={isFavorite}
          onClick={toggle}
          icon={<IsFavoriteIcon favorite={isFavorite} />}
        />
      </SurfaceListItem>
    </SurfaceListItemFrame>
  );
};
