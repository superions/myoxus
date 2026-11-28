// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import { FilterIcon } from "@myoxus/icons/react";
import { IconButton, Menu, MenuItem } from "@myoxus/ui-facade";
import { useState } from "react";

export interface CommentFilterState {
  showResolvedComments: boolean;
  onlyMyReplies: boolean;
  onlyCurrentMode: boolean;
}

export const CommentFilterMenu = ({
  filterState,
  onFilterChange,
}: {
  filterState: CommentFilterState;
  onFilterChange: (key: keyof CommentFilterState, value: boolean) => void;
}) => {
  const t = useI18n();
  const [open, setOpen] = useState(false);

  return (
    <Menu
      noPortal
      rootOptions={{ modal: false, open, onOpenChange: setOpen }}
      items={
        <>
          <MenuItem
            checked={filterState.showResolvedComments}
            onSelect={() =>
              onFilterChange(
                "showResolvedComments",
                !filterState.showResolvedComments,
              )
            }
          >
            {t["com.myoxus.comment.filter.show-resolved"]()}
          </MenuItem>
          <MenuItem
            checked={filterState.onlyMyReplies}
            onSelect={() =>
              onFilterChange("onlyMyReplies", !filterState.onlyMyReplies)
            }
          >
            {t["com.myoxus.comment.filter.only-my-replies"]()}
          </MenuItem>
          <MenuItem
            checked={filterState.onlyCurrentMode}
            onSelect={() =>
              onFilterChange("onlyCurrentMode", !filterState.onlyCurrentMode)
            }
          >
            {t["com.myoxus.comment.filter.only-current-mode"]()}
          </MenuItem>
        </>
      }
    >
      <IconButton
        icon={<FilterIcon />}
        tooltip={t["com.myoxus.filter"]()}
        tooltipOptions={{ opened: open ? false : undefined }}
      />
    </Menu>
  );
};
