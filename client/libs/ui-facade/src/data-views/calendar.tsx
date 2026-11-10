// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import { type DayOfWeek } from "@mantine/dates";
import {
  type ScheduleLabelsOverride,
  type ScheduleViewLevel,
  type ScheduleEventData,
  Schedule as MantineSchedule,
} from "@mantine/schedule";
import { type ReactNode, useMemo } from "react";
import { normalizeDayjsLocale } from "../date-picker";
import dayjs from "dayjs";
import { Card } from "../card";
import { Group } from "@mantine/core";
import { DiamondIcon } from "@myoxus/icons/react";
import { MyoxusText } from "../typography";
import { cssVar } from "@myoxus/theme";

export type DatabaseScheduleEvent = {
  id: string;
  title: string;
  start: string;
  end: string;
  description?: string;
  docId?: string;
  rowId?: string;
  kind?: "range" | "milestone";
};

/** Resolves Mantine's native 0=Sunday..6=Saturday week-start contract. */
export function getLocaleWeekStart(locale?: string) {
  const localeWithWeekInfo = new Intl.Locale(locale || "en") as Intl.Locale & {
    getWeekInfo?: () => { firstDay: number };
    weekInfo?: { firstDay: number };
  };
  const firstDay =
    localeWithWeekInfo.getWeekInfo?.().firstDay ??
    localeWithWeekInfo.weekInfo?.firstDay ??
    1;
  return (firstDay % 7) as DayOfWeek;
}

export interface DatabaseCalendarViewProps {
  date?: string;
  defaultDate?: string;
  events: DatabaseScheduleEvent[];
  labels?: ScheduleLabelsOverride;
  locale?: string;
  /** Reports the selected local calendar day as YYYY-MM-DD. */
  onDateChange?: (date: string) => void;
  onEventSelect?: (event: DatabaseScheduleEvent) => void;
  onViewChange?: (view: ScheduleViewLevel) => void;
  renderEventBody?: (event: DatabaseScheduleEvent) => ReactNode;
  view?: ScheduleViewLevel;
  "data-testid"?: string;
  "data-myoxus-ui-role"?: string;
}

/**
 * Database calendar/schedule surface. Product code supplies server-owned row
 * events only; Mantine Schedule integration, responsive view switching and
 * token-backed event chrome stay inside the Facade boundary.
 */
export function DatabaseCalendarView({
  date,
  defaultDate,
  events,
  labels,
  locale,
  onDateChange,
  onEventSelect,
  onViewChange,
  renderEventBody,
  view,
  "data-testid": dataTestId,
  "data-myoxus-ui-role": uiRole = "database-calendar-view",
}: DatabaseCalendarViewProps) {
  const firstDayOfWeek = getLocaleWeekStart(locale);
  const mantineLocale = normalizeDayjsLocale(locale);
  const scheduleEvents = useMemo<ScheduleEventData[]>(
    () =>
      events.map((event) => ({
        color: "myoxus",
        // Mantine Schedule needs non-zero geometry in day/week views. Keep the
        // payload instant exact while giving point milestones one native slot.
        end:
          event.kind === "milestone" && event.end === event.start
            ? dayjs(event.end).add(15, "minute").format("YYYY-MM-DD HH:mm:ss")
            : event.end,
        id: event.id,
        payload: event,
        start: event.start,
        title: event.title,
        variant: "light",
      })),
    [events],
  );

  return (
    <Card
      padding="default"
      data-testid={dataTestId}
      data-myoxus-ui-role={uiRole}
    >
      <MantineSchedule
        date={date}
        defaultDate={defaultDate}
        events={scheduleEvents}
        labels={labels}
        layout="responsive"
        locale={mantineLocale}
        mobileMonthViewProps={{ firstDayOfWeek }}
        mode={onEventSelect ? "default" : "static"}
        monthViewProps={{ firstDayOfWeek }}
        onDateChange={
          onDateChange
            ? (nextDate) => onDateChange(nextDate.slice(0, 10))
            : undefined
        }
        onEventClick={(event) => {
          const payload = event.payload as DatabaseScheduleEvent | undefined;
          if (payload) onEventSelect?.(payload);
        }}
        renderEventBody={(event) => {
          const payload = event.payload as DatabaseScheduleEvent | undefined;
          const body =
            payload && renderEventBody ? renderEventBody(payload) : event.title;
          return (
            <Group gap="xs" wrap="nowrap">
              {payload?.kind === "milestone" ? (
                <DiamondIcon aria-hidden />
              ) : null}
              <MyoxusText
                component="span"
                lineClamp={1}
                typographySlot="body-small"
              >
                {body}
              </MyoxusText>
            </Group>
          );
        }}
        onViewChange={onViewChange}
        radius={"var(--mantine-radius-md)"}
        view={view}
        weekViewProps={{ firstDayOfWeek }}
        yearViewProps={{ firstDayOfWeek }}
        styles={{
          root: {
            color: cssVar("textPrimaryColor"),
            fontFamily:
              "var(--mantine-font-family-body, var(--mantine-font-family))",
          },
          desktopView: {
            background: cssVar("backgroundPrimaryColor"),
          },
          mobileView: {
            background: cssVar("backgroundPrimaryColor"),
          },
        }}
      />
    </Card>
  );
}
