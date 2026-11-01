// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import {
  ActivityIcon,
  CalendarDaysIcon,
  ListChecksIcon,
} from "@myoxus/icons/react";
import { Scrollable, WorkbenchContextScrollRoot } from "@myoxus/ui-facade";

import {
  JournalActivityToolBody,
  JournalAgendaToolBody,
  JournalCalendarToolBody,
  JournalToolStateProvider,
} from "../detail-page/sidecards/journal";

const JOURNAL_VIEW_FAMILY = ["journal"] as const;

/** Registers the three Journal tools against one route-owned date state. */
export function JournalContextSurface() {
  const t = useI18n();

  return (
    <JournalToolStateProvider>
      <ViewContextSurface
        surfaceId="calendar"
        order={30}
        label={t["com.myoxus.sidebar.tab.journal"]()}
        tooltip={t["com.myoxus.sidebar.tab.journal.tooltip"]()}
        icon={<CalendarDaysIcon />}
        viewFamilies={JOURNAL_VIEW_FAMILY}
      >
        <WorkbenchContextScrollRoot>
          <Scrollable.Viewport data-myoxus-ui-role="journal-context-viewport">
            <JournalCalendarToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </WorkbenchContextScrollRoot>
      </ViewContextSurface>
      <ViewContextSurface
        surfaceId="agenda"
        order={40}
        label={t["com.myoxus.journal.template.section.agenda"]()}
        tooltip={t["com.myoxus.journal.template.section.agenda"]()}
        icon={<ListChecksIcon />}
        viewFamilies={JOURNAL_VIEW_FAMILY}
      >
        <WorkbenchContextScrollRoot>
          <Scrollable.Viewport data-myoxus-ui-role="journal-context-viewport">
            <JournalAgendaToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </WorkbenchContextScrollRoot>
      </ViewContextSurface>
      <ViewContextSurface
        surfaceId="activity"
        order={50}
        label={t["com.myoxus.sidebar.tab.activity"]()}
        tooltip={t["com.myoxus.sidebar.tab.activity.tooltip"]()}
        icon={<ActivityIcon />}
        viewFamilies={JOURNAL_VIEW_FAMILY}
      >
        <WorkbenchContextScrollRoot>
          <Scrollable.Viewport data-myoxus-ui-role="journal-context-viewport">
            <JournalActivityToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </WorkbenchContextScrollRoot>
      </ViewContextSurface>
    </JournalToolStateProvider>
  );
}
