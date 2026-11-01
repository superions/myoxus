import { FavoriteTag } from "@myoxus/core/components/page-list";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { track } from "@myoxus/track";
import { notify } from "@myoxus/ui-facade";
import { useCallback } from "react";

import { getDocumentHeaderActionVariant } from "../action-variant";

export interface FavoriteButtonProps {
  pageId: string;
}

export const useFavorite = (pageId: string) => {
  const t = useI18n();
  const favAdapter = useService(CompatibleFavoriteItemsAdapter);

  const favorite = useLiveData(favAdapter.isFavorite$(pageId, "doc"));

  const toggleFavorite = useCallback(() => {
    favAdapter.toggle(pageId, "doc");
    notify({
      title: favorite
        ? t["com.myoxus.toastMessage.removedFavorites"]()
        : t["com.myoxus.toastMessage.addedFavorites"](),
    });
  }, [favorite, pageId, t, favAdapter]);

  return { favorite, toggleFavorite };
};

export const FavoriteButton = ({ pageId }: FavoriteButtonProps) => {
  const { favorite, toggleFavorite } = useFavorite(pageId);
  const favoriteActive = !!favorite;

  const handleFavorite = useCallback(() => {
    track.$.header.actions.toggleFavorite();
    toggleFavorite();
  }, [toggleFavorite]);

  return (
    <FavoriteTag
      data-testid="pin-button"
      active={favoriteActive}
      onClick={handleFavorite}
      variant={getDocumentHeaderActionVariant(favoriteActive)}
    />
  );
};
