// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { ExplorerDisplayMenu } from "@myoxus/core/components/explorer/display-menu";
import {
  type AllContentView,
  ViewToggle,
} from "@myoxus/core/components/explorer/display-menu/view-toggle";
import type { ExplorerDisplayPreference } from "@myoxus/core/components/explorer/types";
import { useI18n } from "@myoxus/i18n";
import { FilterIcon } from "@myoxus/icons/react";
import {
  Button,
  HeaderActionPrioritySlot,
  HeaderMenuButton,
  MenuItem,
  WorkbenchHeaderContextPath,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";

export function AllDocsHeader({
  displayPreference,
  onEditCollectionRules,
  onDisplayPreferenceChange,
  title,
  view,
  onViewChange,
  includeGraph,
}: {
  displayPreference: ExplorerDisplayPreference;
  onEditCollectionRules?: () => void;
  onDisplayPreferenceChange: (
    displayPreference: ExplorerDisplayPreference,
  ) => void;
  title?: string;
  view: AllContentView;
  onViewChange: (view: AllContentView) => void;
  includeGraph?: boolean;
}) {
  const t = useI18n();

  return (
    <WorkbenchHeaderFrame
      data-myoxus-ui-role="all-docs-header-frame"
      left={
        <ViewToggle
          view={view}
          onViewChange={onViewChange}
          includeGraph={includeGraph}
        />
      }
      title={
        <WorkbenchHeaderContextPath current={title ?? t["All content"]()} />
      }
      right={
        <>
          {onEditCollectionRules ? (
            <HeaderActionPrioritySlot priority="wide">
              <Button
                data-testid="all-docs-edit-collection-rules"
                onClick={onEditCollectionRules}
                prefix={<FilterIcon />}
                tooltip={t["com.myoxus.all-docs.pinned-collection.edit"]()}
              >
                {t["com.myoxus.editCollection.rules"]()}
              </Button>
            </HeaderActionPrioritySlot>
          ) : null}
          {view !== "graph" ? (
            <HeaderMenuButton
              ariaLabel={t["com.myoxus.common.open-menu"]()}
              data-testid="all-docs-header-menu-trigger"
              items={
                <ExplorerDisplayMenu
                  displayPreference={displayPreference}
                  leadingItems={
                    onEditCollectionRules ? (
                      <MenuItem
                        prefixIcon={<FilterIcon />}
                        onSelect={onEditCollectionRules}
                      >
                        {t["com.myoxus.editCollection.rules"]()}
                      </MenuItem>
                    ) : null
                  }
                  onDisplayPreferenceChange={onDisplayPreferenceChange}
                />
              }
            />
          ) : null}
        </>
      }
    />
  );
}
