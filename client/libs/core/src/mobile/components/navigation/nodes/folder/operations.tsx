import { IsFavoriteIcon } from "@myoxus/core/components/pure/icons";
import { CompatibleFavoriteItemsAdapter } from "@myoxus/core/modules/favorite";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { MenuItem } from "@myoxus/ui-facade";
import { useMemo } from "react";

export const FavoriteFolderOperation = ({ id }: { id: string }) => {
  const t = useI18n();
  const compatibleFavoriteItemsAdapter = useService(
    CompatibleFavoriteItemsAdapter,
  );

  const favorite = useLiveData(
    useMemo(() => {
      return compatibleFavoriteItemsAdapter.isFavorite$(id, "folder");
    }, [compatibleFavoriteItemsAdapter, id]),
  );

  return (
    <MenuItem
      prefixIcon={<IsFavoriteIcon favorite={favorite} />}
      onClick={() => compatibleFavoriteItemsAdapter.toggle(id, "folder")}
    >
      {favorite
        ? t["com.myoxus.rootAppSidebar.organize.folder-rm-favorite"]()
        : t["com.myoxus.rootAppSidebar.organize.folder-add-favorite"]()}
    </MenuItem>
  );
};
