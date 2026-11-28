// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  JOURNAL_DATE_FORMAT,
  JournalService,
} from "@myoxus/core/modules/journal";
import {
  ViewBody,
  ViewHeader,
  ViewService,
  WorkbenchService,
  WorkbenchToolLayoutBinding,
} from "@myoxus/core/modules/workbench";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { i18nTime, useI18n } from "@myoxus/i18n";
import { TodayIcon } from "@myoxus/icons/react";
import { useLiveData, useService } from "@myoxus/infra";
import { getArtworkUrl } from "@myoxus/theme/artwork";
import {
  Badge,
  Button,
  EmptyState,
  EmptyStateTitle,
  MyoxusTitle,
  PageContentRail,
  Stack,
  ThemedImg,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { Location } from "react-router";

import { JournalContextSurface } from "./journal-context-surface";
import { JournalWorkbenchHeader } from "./journal-workbench-header";

export function getDateFromUrl(location: Location): string {
  const rawDate = new URLSearchParams(location.search).get("date");
  return (rawDate ? dayjs(rawDate) : dayjs()).format(JOURNAL_DATE_FORMAT);
}

function JournalPlaceholderTitle({ dateString }: { dateString: string }) {
  const localizedDate = i18nTime(dateString, { absolute: { accuracy: "day" } });
  const parsed = dayjs(dateString);
  const isToday = parsed.isSame(dayjs(), "day");

  return (
    <Stack
      align="center"
      gap="xs"
      data-myoxus-ui-role="journal-placeholder-title-stack"
    >
      <MyoxusTitle
        order={1}
        textAlign="center"
        data-testid="journal-title"
        data-myoxus-ui-role="journal-placeholder-title"
      >
        <span data-testid="date">{localizedDate}</span>
      </MyoxusTitle>
      {!isToday ? (
        <Badge data-myoxus-ui-role="journal-placeholder-weekday">
          {parsed.format("dddd")}
        </Badge>
      ) : null}
    </Stack>
  );
}

export function JournalPlaceholder({ dateString }: { dateString: string }) {
  const t = useI18n();
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const workbench = useService(WorkbenchService).workbench;
  const journalService = useService(JournalService);

  const handleCreate = useCallback(() => {
    if (creatingRef.current) {
      return;
    }
    creatingRef.current = true;
    setCreating(true);

    // Defer synchronous store/template setup out of the pointer handler so the
    // UI stays responsive before navigating to the newly created journal doc.
    window.setTimeout(() => {
      try {
        const doc = journalService.ensureJournalByDate(dateString);
        workbench.openDoc(doc.id, { replaceHistory: true, at: "active" });
      } catch (error) {
        console.error("[journal] create daily journal failed", {
          date: dateString,
          error,
        });
        creatingRef.current = false;
        setCreating(false);
      }
    }, 0);
  }, [dateString, journalService, workbench]);

  return (
    <PageContentRail
      width="data"
      scroll
      data-myoxus-ui-role="journal-placeholder-page"
    >
      <Stack
        align="center"
        gap="xl"
        data-myoxus-ui-role="journal-placeholder-layout"
      >
        <JournalPlaceholderTitle dateString={dateString} />
        <EmptyState
          media={<ThemedImg fluid alt="" lightSrc={getArtworkUrl("journal")} />}
          title={
            <EmptyStateTitle icon={<TodayIcon />}>
              {t["com.myoxus.journal.placeholder.title"]()}
            </EmptyStateTitle>
          }
          cta={
            <Button
              variant="primary"
              onClick={handleCreate}
              disabled={creating}
              aria-busy={creating}
              data-testid="confirm-create-journal-button"
            >
              {t["com.myoxus.journal.placeholder.create"]()}
            </Button>
          }
          data-myoxus-ui-role="journal-placeholder-empty-state"
        />
      </Stack>
    </PageContentRail>
  );
}

export function JournalsPageWithConfirmation() {
  const journalService = useService(JournalService);
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const workspace = useService(WorkspaceService).workspace;
  const location = useLiveData(view.location$);
  const dateString = getDateFromUrl(location);
  const journals = useLiveData(journalService.journalsByDate$(dateString));
  const [ready, setReady] = useState(false);

  const openJournalDate = useCallback(
    (date: string) => {
      workbench.open(`/journals?date=${date}`, { at: "active" });
    },
    [workbench],
  );

  useLayoutEffect(() => {
    if (!location.pathname.startsWith("/journals")) {
      return;
    }
    if (journals.length === 0) {
      view.showTool("calendar");
      workbench.openContextPanel();
      if (!ready) {
        setReady(true);
      }
      return;
    }
    workbench.openDoc(journals[0].id, { replaceHistory: true, at: "active" });
  }, [dateString, journals, location.pathname, ready, view, workbench]);

  if (!ready) {
    return null;
  }

  return (
    <>
      <WorkbenchToolLayoutBinding
        workspaceId={workspace.id}
        viewFamily="journal"
      />
      <ViewHeader>
        <JournalWorkbenchHeader
          dateString={dateString}
          title=""
          onDateChange={openJournalDate}
        />
      </ViewHeader>
      <ViewBody>
        <JournalPlaceholder dateString={dateString} />
      </ViewBody>
      <JournalContextSurface />
    </>
  );
}

export function Component() {
  return <JournalsPageWithConfirmation />;
}
