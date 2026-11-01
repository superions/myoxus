// SPDX-License-Identifier: AGPL-3.0-or-later

import { useRegionalFormatters } from "@myoxus/core/components/hooks/myoxus/use-user-preferences";
import { useJournalRouteHelper } from "@myoxus/core/components/hooks/use-journal";
import { IntegrationService } from "@myoxus/core/modules/integration";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { UserFriendlyError } from "@myoxus/error";
import { useI18n } from "@myoxus/i18n";
import { CalendarClockIcon, JournalIcon, TodayIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import {
  Button,
  Grid,
  Group,
  Loading,
  MyoxusText,
  NavigationLink,
  Notice,
  Stack,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { DashboardSection } from "./section";

type CalendarState = "error" | "loading" | "ready" | "unavailable";

export const TodaySection = () => {
  const t = useI18n();
  const { formatDate, formatTime } = useRegionalFormatters();
  const workspace = useService(WorkspaceService).workspace;
  const calendar = useService(IntegrationService).calendar;
  const { openToday } = useJournalRouteHelper();
  const [calendarState, setCalendarState] = useState<CalendarState>(
    workspace.flavour === "local" ? "unavailable" : "loading",
  );
  const [calendarError, setCalendarError] = useState<string | null>(null);
  const [calendarReload, setCalendarReload] = useState(0);
  const calendarRequestGeneration = useRef(0);
  const today = useMemo(() => dayjs().startOf("day"), []);
  const rangeEnd = useMemo(() => today.add(6, "day"), [today]);
  const upcoming = useLiveData(
    useMemo(() => calendar.upcomingEvents$(3), [calendar]),
  );

  const loadCalendar = useCallback(
    async (signal: AbortSignal, generation: number) => {
      if (workspace.flavour === "local") {
        setCalendarState("unavailable");
        return;
      }
      setCalendarError(null);
      setCalendarState("loading");
      try {
        const [, calendars] = await Promise.all([
          calendar.loadAccountCalendars(),
          calendar.revalidateWorkspaceCalendars(),
        ]);
        if (
          signal.aborted ||
          generation !== calendarRequestGeneration.current
        ) {
          return;
        }
        if (calendars.length === 0) {
          setCalendarState("unavailable");
          return;
        }
        await calendar.revalidateEventsRange(today, rangeEnd, signal);
        if (
          !signal.aborted &&
          generation === calendarRequestGeneration.current
        ) {
          setCalendarState("ready");
        }
      } catch (error) {
        if (
          signal.aborted ||
          generation !== calendarRequestGeneration.current
        ) {
          return;
        }
        setCalendarError(UserFriendlyError.fromAny(error).message);
        setCalendarState("error");
      }
    },
    [calendar, rangeEnd, today, workspace.flavour],
  );

  useEffect(() => {
    const controller = new AbortController();
    const generation = calendarRequestGeneration.current + 1;
    calendarRequestGeneration.current = generation;
    void loadCalendar(controller.signal, generation);
    return () => controller.abort();
  }, [calendarReload, loadCalendar]);

  const retryCalendar = useCallback(() => {
    setCalendarReload((value) => value + 1);
  }, []);

  return (
    <DashboardSection
      icon={<TodayIcon aria-hidden />}
      scope={formatDate(today.toDate())}
      title={t["com.myoxus.today"]()}
      uiRole="workspace-home-today"
    >
      <Grid columns={12}>
        <Grid.Col span={{ base: 12, md: 5 }}>
          <NavigationLink
            component="button"
            type="button"
            label={t["com.myoxus.command-center.today-journal"]()}
            description={formatDate(today.toDate())}
            leftSection={<JournalIcon />}
            onClick={() => openToday({ at: "active" })}
            data-myoxus-ui-role="workspace-home-today-journal"
          />
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 7 }}>
          {calendarState === "loading" ? (
            <Group justify="center">
              <Loading />
            </Group>
          ) : calendarState === "error" ? (
            <Notice
              title={t["com.myoxus.integration.calendar.account.load-error"]()}
              tone="error"
            >
              <Stack gap="xs">
                {calendarError ? (
                  <MyoxusText tone="secondary">{calendarError}</MyoxusText>
                ) : null}
                <Button variant="plain" onClick={retryCalendar}>
                  {t["Retry"]()}
                </Button>
              </Stack>
            </Notice>
          ) : calendarState === "unavailable" ? (
            <Stack align="center" gap="xs">
              <CalendarClockIcon />
              <MyoxusText typographySlot="nav">
                {t["com.myoxus.integration.calendar.account.linked-empty"]()}
              </MyoxusText>
              <MyoxusText
                textAlign="center"
                tone="secondary"
                typographySlot="body-small"
              >
                {t["com.myoxus.workspace-home.calendar-optional"]()}
              </MyoxusText>
            </Stack>
          ) : upcoming.length === 0 ? (
            <MyoxusText textAlign="center" tone="secondary">
              {t["com.myoxus.integration.calendar.section.empty"]()}
            </MyoxusText>
          ) : (
            <Stack gap={0}>
              {upcoming.map((event) => (
                <NavigationLink
                  component="div"
                  key={event.id}
                  label={
                    event.title ||
                    t["com.myoxus.integration.calendar.untitled-event"]()
                  }
                  description={
                    event.allDay
                      ? formatDate(event.startAtUtc)
                      : `${formatDate(event.startAtUtc)} · ${formatTime(
                          event.startAtUtc,
                        )}`
                  }
                  leftSection={<CalendarClockIcon />}
                  data-myoxus-ui-role="workspace-home-calendar-event"
                />
              ))}
            </Stack>
          )}
        </Grid.Col>
      </Grid>
    </DashboardSection>
  );
};
