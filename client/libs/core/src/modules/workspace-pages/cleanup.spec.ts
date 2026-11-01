// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import { cleanupDatabasePageProjections } from "./cleanup";

describe("Database Page projection cleanup", () => {
  test("removes both persisted organizer projections after authoritative deletion", () => {
    const removeFavorite = vi.fn();
    const removeLinksForTarget = vi.fn();
    const favoriteService = {
      favoriteList: {
        isFavorite$: vi.fn(() => ({ value: true })),
        remove: removeFavorite,
      },
    };
    const organizeService = {
      folderTree: { removeLinksForTarget },
    };

    cleanupDatabasePageProjections(
      "database-1",
      favoriteService as never,
      organizeService as never,
    );

    expect(removeFavorite).toHaveBeenCalledExactlyOnceWith(
      "database",
      "database-1",
    );
    expect(removeLinksForTarget).toHaveBeenCalledExactlyOnceWith(
      "database",
      "database-1",
    );
  });
});
