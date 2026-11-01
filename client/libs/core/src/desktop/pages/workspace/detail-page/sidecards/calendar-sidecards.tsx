// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: MIT

import { ViewContextSurface } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import {
  ActivityIcon,
  CalendarDaysIcon,
  ListChecksIcon,
} from "@myoxus/icons/react";
import { DetailPageContextScrollRoot, Scrollable } from "@myoxus/ui-facade";

import {
  JournalActivityToolBody,
  JournalAgendaToolBody,
  JournalCalendarToolBody,
  JournalToolStateProvider,
} from "./journal";

const DOCUMENT_VIEW_FAMILIES = [
  "document-page",
  "document-edgeless",
  "journal",
] as const;
const JOURNAL_VIEW_FAMILY = ["journal"] as const;

/**
 * Keeps Calendar and Agenda available in every document context while adding
 * the Journal-specific activity card only for journal documents.
 */
export function CalendarSidecards({
  includeJournalActivity,
  readonly,
}: {
  includeJournalActivity: boolean;
  readonly: boolean;
}) {
  const t = useI18n();

  return (
    <JournalToolStateProvider readonly={readonly}>
      <ViewContextSurface
        surfaceId="calendar"
        order={30}
        label={t["com.myoxus.sidebar.tab.journal"]()}
        tooltip={t["com.myoxus.sidebar.tab.journal.tooltip"]()}
        icon={<CalendarDaysIcon />}
        viewFamilies={DOCUMENT_VIEW_FAMILIES}
      >
        <DetailPageContextScrollRoot>
          <Scrollable.Viewport>
            <JournalCalendarToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </DetailPageContextScrollRoot>
      </ViewContextSurface>
      <ViewContextSurface
        surfaceId="agenda"
        order={40}
        label={t["com.myoxus.journal.template.section.agenda"]()}
        tooltip={t["com.myoxus.journal.template.section.agenda"]()}
        icon={<ListChecksIcon />}
        viewFamilies={DOCUMENT_VIEW_FAMILIES}
      >
        <DetailPageContextScrollRoot>
          <Scrollable.Viewport>
            <JournalAgendaToolBody />
          </Scrollable.Viewport>
          <Scrollable.Scrollbar />
        </DetailPageContextScrollRoot>
      </ViewContextSurface>
      {includeJournalActivity ? (
        <ViewContextSurface
          surfaceId="activity"
          order={50}
          label={t["com.myoxus.sidebar.tab.activity"]()}
          tooltip={t["com.myoxus.sidebar.tab.activity.tooltip"]()}
          icon={<ActivityIcon />}
          viewFamilies={JOURNAL_VIEW_FAMILY}
        >
          <DetailPageContextScrollRoot>
            <Scrollable.Viewport>
              <JournalActivityToolBody />
            </Scrollable.Viewport>
            <Scrollable.Scrollbar />
          </DetailPageContextScrollRoot>
        </ViewContextSurface>
      ) : null}
    </JournalToolStateProvider>
  );
}
