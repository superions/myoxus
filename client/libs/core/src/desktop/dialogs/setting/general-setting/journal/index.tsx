/**
 * Journal user settings — calendar week display and first day of week.
 *
 * Hierarchy: user override > server default > product default.
 *
 * Reads application-resolved effective preferences. Changes go through the
 * account/server-scoped offline projection; this component owns no storage or
 * direct GraphQL path.
 */
import { UserPreferencesService } from "@myoxus/core/modules/server";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { useI18n } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { useCallback, useEffect } from "react";

import {
  setFirstDayOfWeek,
  setTimezone,
} from "../../../../../modules/journal/dayjs-week-config";
import {
  FormSelect,
  notify,
  SettingHeader,
  SettingRow,
  SettingWrapper,
  Stack,
  Switch,
} from "../../primitives";
import { WorkspaceCalendarSettings } from "../../workspace-setting/calendar";
import { CalendarSettingPanel } from "../../workspace-setting/integration/calendar/setting-panel";
import { CalendarAccountsSettings } from "./calendar-accounts";

export function JournalSettings() {
  const t = useI18n();
  const userPreferencesService = useService(UserPreferencesService);
  const preferences = useLiveData(userPreferencesService.userPreferences$);
  const workspaceService = useService(WorkspaceService);
  const isCloudWorkspace = workspaceService.workspace.flavour !== "local";
  const showCalendarWeeks =
    preferences?.effectiveValues.journalShowCalendarWeeks ?? true;
  const firstDay =
    preferences?.effectiveValues.journalFirstDayOfWeek ?? "monday";

  useEffect(() => {
    void userPreferencesService.revalidate();
  }, [userPreferencesService]);

  useEffect(() => {
    setFirstDayOfWeek(firstDay);
    setTimezone(preferences?.effectiveValues.timezone ?? "UTC");
  }, [firstDay, preferences?.effectiveValues.timezone]);

  const handleFirstDayChange = useCallback(
    (value: string) => {
      setFirstDayOfWeek(value);
      userPreferencesService
        .update({ journalFirstDayOfWeek: value })
        .catch(() => {
          notify.error({
            title: t["com.myoxus.settings.journal.save-error"](),
          });
        });
    },
    [userPreferencesService, t],
  );

  const handleShowKwChange = useCallback(
    (value: boolean) => {
      userPreferencesService
        .update({ journalShowCalendarWeeks: value })
        .catch(() => {
          notify.error({
            title: t["com.myoxus.settings.journal.save-error"](),
          });
        });
    },
    [userPreferencesService, t],
  );

  return (
    <Stack data-myoxus-ui-role="journal-settings-page">
      <SettingHeader
        title={t["com.myoxus.settings.journal"]()}
        subtitle={t["com.myoxus.settings.journal.subtitle"]()}
      />
      <SettingWrapper
        title={t["com.myoxus.settings.journal.calendar-section"]()}
      >
        <SettingRow
          name={t["com.myoxus.common.calendar.show-weeks"]()}
          desc={t["com.myoxus.common.calendar.show-weeks.desc"]()}
        >
          <Switch checked={showCalendarWeeks} onChange={handleShowKwChange} />
        </SettingRow>
        <SettingRow
          name={t["com.myoxus.common.week.first-day"]()}
          desc={t["com.myoxus.common.week.first-day.desc"]()}
        >
          <FormSelect
            value={firstDay}
            onChange={handleFirstDayChange}
            data={[
              {
                value: "monday",
                label: t["com.myoxus.common.week.monday"](),
              },
              {
                value: "sunday",
                label: t["com.myoxus.common.week.sunday"](),
              },
            ]}
          />
        </SettingRow>
      </SettingWrapper>
      <SettingWrapper title={t["com.myoxus.integration.calendar.name"]()}>
        <Stack data-myoxus-ui-role="journal-calendar-integration-stack">
          <CalendarAccountsSettings embedded />
          {isCloudWorkspace ? <CalendarSettingPanel /> : null}
        </Stack>
      </SettingWrapper>
      <WorkspaceCalendarSettings showHeader={false} />
    </Stack>
  );
}
