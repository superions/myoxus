// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { useI18n } from "@myoxus/i18n";
import track from "@myoxus/track";
import { Checkbox, MenuItem, MenuSub } from "@myoxus/ui-facade";
import { useCallback } from "react";

import {
  listQuickActions,
  type QuickAction,
  quickActions,
} from "../quick-actions.constants";
import type { ExplorerDisplayPreference } from "../types";

const QuickActionToggleItem = ({
  action,
  active,
  onToggle,
}: {
  action: QuickAction;
  active: boolean;
  onToggle: () => void;
}) => {
  const t = useI18n();
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      event.preventDefault();
      onToggle();
    },
    [onToggle],
  );

  return (
    <MenuItem prefixIcon={<Checkbox checked={active} />} onClick={handleClick}>
      {t.t(action.name)}
    </MenuItem>
  );
};

export const QuickActionsConfig = ({
  displayPreference,
  onDisplayPreferenceChange,
}: {
  displayPreference: ExplorerDisplayPreference;
  onDisplayPreferenceChange: (
    displayPreference: ExplorerDisplayPreference,
  ) => void;
}) => {
  const t = useI18n();
  const actions =
    displayPreference.view === "list" ? listQuickActions : quickActions;

  return (
    <MenuSub
      items={actions
        .filter((action) => !action.disabled)
        .map((action) => (
          <QuickActionToggleItem
            key={action.key}
            action={action}
            active={Boolean(displayPreference[action.key])}
            onToggle={() => {
              track.allDocs.header.displayMenu.editDisplayMenu({
                control: "quickActions",
                type: action.key,
              });
              onDisplayPreferenceChange({
                ...displayPreference,
                [action.key]: !displayPreference[action.key],
              });
            }}
          />
        ))}
    >
      {t["com.myoxus.all-docs.quick-actions"]()}
    </MenuSub>
  );
};
