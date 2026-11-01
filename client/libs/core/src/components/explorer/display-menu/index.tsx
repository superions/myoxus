import type {
  GroupByParams,
  OrderByParams,
} from "@myoxus/core/modules/collection-rules/types";
import { useI18n } from "@myoxus/i18n";
import { ViewIcon } from "@myoxus/icons/react";
import {
  Divider,
  HeaderActionResponsiveLabel,
  Menu,
  MenuPanel,
  type MenuProps,
  MenuSub,
  MenuSummaryRow,
  MenuTrigger,
} from "@myoxus/ui-facade";
import { type ReactNode, useCallback } from "react";

import type { ExplorerDisplayPreference } from "../types";
import { GroupByList, GroupByName } from "./group";
import { OrderByList, OrderByName } from "./order";
import { DisplayProperties } from "./properties";
import { QuickActionsConfig } from "./quick-actions";

export const ExplorerDisplayMenu = ({
  displayPreference,
  leadingItems,
  onDisplayPreferenceChange,
}: {
  displayPreference: ExplorerDisplayPreference;
  leadingItems?: ReactNode;
  onDisplayPreferenceChange: (
    displayPreference: ExplorerDisplayPreference,
  ) => void;
}) => {
  const t = useI18n();

  const handleGroupByChange = useCallback(
    (groupBy: GroupByParams | undefined) => {
      onDisplayPreferenceChange({ ...displayPreference, groupBy });
    },
    [displayPreference, onDisplayPreferenceChange],
  );

  const handleOrderByChange = useCallback(
    (orderBy: OrderByParams) => {
      onDisplayPreferenceChange({ ...displayPreference, orderBy });
    },
    [displayPreference, onDisplayPreferenceChange],
  );

  return (
    <MenuPanel panelWidth="display">
      {leadingItems}
      {leadingItems ? <Divider space={4} size="thinner" /> : null}
      <MenuSub
        items={
          <GroupByList
            groupBy={displayPreference.groupBy}
            onChange={handleGroupByChange}
          />
        }
      >
        <MenuSummaryRow
          label={t["com.myoxus.explorer.display-menu.grouping"]()}
          value={
            displayPreference.groupBy ? (
              <GroupByName groupBy={displayPreference.groupBy} />
            ) : null
          }
        />
      </MenuSub>
      <MenuSub
        items={
          <OrderByList
            orderBy={displayPreference.orderBy}
            onChange={handleOrderByChange}
          />
        }
      >
        <MenuSummaryRow
          label={t["com.myoxus.explorer.display-menu.ordering"]()}
          value={
            displayPreference.orderBy ? (
              <OrderByName orderBy={displayPreference.orderBy} />
            ) : null
          }
        />
      </MenuSub>
      <Divider space={4} size="thinner" />
      <DisplayProperties
        displayPreference={displayPreference}
        onDisplayPreferenceChange={onDisplayPreferenceChange}
      />

      <Divider space={4} size="thinner" />
      <QuickActionsConfig
        displayPreference={displayPreference}
        onDisplayPreferenceChange={onDisplayPreferenceChange}
      />
    </MenuPanel>
  );
};

export const ExplorerDisplayMenuButton = ({
  menuProps,
  displayPreference,
  onDisplayPreferenceChange,
}: {
  menuProps?: Omit<MenuProps, "items" | "children">;
  displayPreference: ExplorerDisplayPreference;
  onDisplayPreferenceChange: (
    displayPreference: ExplorerDisplayPreference,
  ) => void;
}) => {
  const t = useI18n();
  const label = t["com.myoxus.explorer.display-menu.button"]();
  return (
    <Menu
      items={
        <ExplorerDisplayMenu
          displayPreference={displayPreference}
          onDisplayPreferenceChange={onDisplayPreferenceChange}
        />
      }
      {...menuProps}
    >
      <MenuTrigger
        aria-label={label}
        data-testid="explorer-display-menu-button"
        data-myoxus-ui-role="explorer-display-menu-trigger"
        prefix={<ViewIcon />}
      >
        <HeaderActionResponsiveLabel wide={label} narrow="" />
      </MenuTrigger>
    </Menu>
  );
};
