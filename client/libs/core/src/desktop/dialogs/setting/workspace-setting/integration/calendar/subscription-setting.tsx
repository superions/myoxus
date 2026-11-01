import type { CalendarAccountsQuery } from "@myoxus/graphql";
import { cssVar } from "@myoxus/theme";
import { useCallback } from "react";

import {
  Checkbox,
  ColorSwatch,
  SettingsListItemMeta,
  SettingsListItemTitle,
  SurfaceListItem,
  SurfaceListItemMain,
} from "../../../primitives";

type CalendarSubscription = NonNullable<
  NonNullable<CalendarAccountsQuery["currentUser"]>["calendarAccounts"][number]
>["calendars"][number];

export const SubscriptionSetting = ({
  subscription,
  checked,
  onToggle,
}: {
  subscription: CalendarSubscription;
  checked: boolean;
  onToggle: (id: string, checked: boolean) => void;
}) => {
  const handleToggle = useCallback(
    (nextChecked: boolean) => {
      onToggle(subscription.id, nextChecked);
    },
    [onToggle, subscription.id],
  );

  const displayName =
    subscription.displayName ?? subscription.externalCalendarId;

  return (
    <SurfaceListItem
      component="div"
      role="button"
      tabIndex={0}
      appearance="row"
      density="compact"
      layout="row"
      alignItems="center"
      interactive
      onClick={() => handleToggle(!checked)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          handleToggle(!checked);
        }
      }}
    >
      <Checkbox
        checked={checked}
        onChange={(_, nextChecked) => handleToggle(nextChecked)}
        onClick={(event) => event.stopPropagation()}
        aria-label={displayName}
      />
      <ColorSwatch
        color={subscription.color || cssVar("primaryColor")}
        shape="circle"
      />
      <SurfaceListItemMain compact>
        <SettingsListItemTitle truncate>{displayName}</SettingsListItemTitle>
        {subscription.timezone ? (
          <SettingsListItemMeta truncate>
            {subscription.timezone}
          </SettingsListItemMeta>
        ) : null}
      </SurfaceListItemMain>
    </SurfaceListItem>
  );
};
