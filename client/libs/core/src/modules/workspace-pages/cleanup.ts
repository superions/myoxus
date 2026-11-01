// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FavoriteService } from "@myoxus/core/modules/favorite";
import type { OrganizeService } from "@myoxus/core/modules/organize";

/** Remove user-owned organizer projections after authoritative deletion. */
export function cleanupDatabasePageProjections(
  databaseId: string,
  favoriteService: FavoriteService,
  organizeService: OrganizeService,
) {
  if (favoriteService.favoriteList.isFavorite$("database", databaseId).value) {
    favoriteService.favoriteList.remove("database", databaseId);
  }
  organizeService.folderTree.removeLinksForTarget("database", databaseId);
}
