// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import {
  CopyIcon,
  DatabaseIcon,
  DeleteIcon,
  FavoritedIcon,
  FavoriteIcon,
  FolderIcon,
  OpenInNewIcon,
  SplitViewIcon,
} from "@myoxus/icons/react";
import { MenuItem, MenuSeparator } from "@myoxus/ui-facade";

import type { DatabasePageActions } from "./use-database-page-actions";

/** Exact Database Page capability menu; document actions do not enter here. */
export function DatabasePageMenuItems({
  actions,
  favorite,
  onMove,
}: {
  actions: DatabasePageActions;
  favorite: boolean;
  onMove: () => void;
}) {
  const t = useI18n();
  return (
    <>
      <MenuItem
        prefixIcon={<DatabaseIcon />}
        onClick={() => actions.open()}
        data-testid="database-page-action-open"
      >
        {t["com.myoxus.workspace-pages.action.open"]()}
      </MenuItem>
      <MenuItem
        prefixIcon={<SplitViewIcon />}
        onClick={() => actions.open("beside")}
        data-testid="database-page-action-open-beside"
      >
        {t["com.myoxus.workbench.split-view.page-menu-open"]()}
      </MenuItem>
      <MenuItem
        prefixIcon={<OpenInNewIcon />}
        onClick={() => actions.open("new-tab")}
        data-testid="database-page-action-open-new-tab"
      >
        {t["com.myoxus.workbench.tab.page-menu-open"]()}
      </MenuItem>
      {!actions.protectedRoot ? (
        <>
          <MenuItem
            prefixIcon={favorite ? <FavoritedIcon /> : <FavoriteIcon />}
            onClick={actions.toggleFavorite}
            data-testid="database-page-action-favorite"
          >
            {favorite ? t["Favorited"]() : t["Favorite"]()}
          </MenuItem>
          <MenuItem
            prefixIcon={<FolderIcon />}
            onClick={onMove}
            data-testid="database-page-action-move"
          >
            {t["com.myoxus.workspace-pages.move.title"]()}
          </MenuItem>
        </>
      ) : null}
      <MenuItem
        prefixIcon={<CopyIcon />}
        onClick={() => void actions.copyLink()}
        data-testid="database-page-action-copy-link"
      >
        {t["com.myoxus.comment.copy-link"]()}
      </MenuItem>
      {!actions.protectedRoot ? (
        <>
          <MenuSeparator />
          <MenuItem
            type="danger"
            prefixIcon={<DeleteIcon />}
            onClick={actions.remove}
            data-testid="database-page-action-trash"
          >
            {t["com.myoxus.moveToTrash.title"]()}
          </MenuItem>
        </>
      ) : null}
    </>
  );
}
