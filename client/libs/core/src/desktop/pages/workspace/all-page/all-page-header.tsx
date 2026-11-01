/**
 * All-docs page header component.
 *
 * Renders the toolbar row at the top of the all-pages view, containing:
 * - `<ViewToggle>` — switches between list, grid, and masonry view modes.
 * - A centered title.
 * - A context menu containing display preferences.
 */
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

/**
 * Header toolbar for the all-docs workbench view.
 *
 * Document creation deliberately lives with the document list instead of in
 * this route header. The document itself owns switching between page and
 * edgeless mode, so the list needs only one unambiguous create action.
 *
 * @param displayPreference - Current display options (sort, group, columns).
 * @param onDisplayPreferenceChange - Called when the user changes display options.
 * @param view - Currently active view mode (`list` | `grid` | `masonry`).
 * @param onViewChange - Called when the user switches between view modes.
 */
export const AllDocsHeader = ({
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
}) => {
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
};
