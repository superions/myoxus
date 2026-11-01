import { getArtworkUrl } from "@myoxus/theme/artwork";
/**
 * Journals page — the daily-note / journal entry point.
 *
 * The `/journals` route acts as a smart redirector:
 *
 * - If a journal document already exists for the requested date, it immediately
 *   opens that document (replacing the history entry so the back button works
 *   naturally).
 * - If no journal document exists for the requested date, the
 *   `<JournalPlaceholder>` is shown with a "Create" button.
 *
 * The target date is read from the `?date=YYYY-MM-DD` search parameter and
 * defaults to today's date when absent.
 *
 * Navigation between dates is handled by a Mantine-backed `<MiniCalendar>` in
 * the view header. It always renders the selected date's week and uses the
 * active UI locale for labels. A "Today" button appears whenever the selected
 * date is not today.
 *
 * Exports:
 * - `getDateFromUrl` — pure helper to extract the date string from a location.
 * - `JournalPlaceholder` — empty-state view with date title and create button.
 * - `JournalsPageWithConfirmation` — the full page component.
 * - `Component` — lazy route entry point.
 */
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
import {
  Badge,
  Button,
  EmptyState,
  ThemedImg,
  EmptyStateTitle,
  MyoxusTitle,
  PageContentRail,
  Stack,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import type { Location } from "react-router";
import { useCallback, useLayoutEffect, useRef, useState } from "react";

import { JournalContextSurface } from "./journal-context-surface";
import { JournalWorkbenchHeader } from "./journal-workbench-header";

/**
 * Extracts the journal date from the current URL's search parameters.
 *
 * Reads the `date` query param and parses it with dayjs. Falls back to today's
 * date when the param is absent. The result is always formatted using the
 * standard `JOURNAL_DATE_FORMAT` (typically `YYYY-MM-DD`).
 *
 * @param location - React Router / history location object.
 * @returns Formatted date string (e.g. `"2024-03-15"`).
 */
export function getDateFromUrl(location: Location) {
  const searchParams = new URLSearchParams(location.search);
  const date = searchParams.get("date")
    ? dayjs(searchParams.get("date"))
    : dayjs();
  return date.format(JOURNAL_DATE_FORMAT);
}

/**
 * Journals uses the same date wording as the editor title, but owns its page
 * chrome through Facade typography instead of overriding editor CSS classes.
 */
const JournalPlaceholderTitle = ({ dateString }: { dateString: string }) => {
  const localizedJournalDate = i18nTime(dateString, {
    absolute: { accuracy: "day" },
  });
  const date = dayjs(dateString);
  const isToday = date.isSame(dayjs(), "day");

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
        <span data-testid="date">{localizedJournalDate}</span>
      </MyoxusTitle>
      {!isToday ? (
        <Badge data-myoxus-ui-role="journal-placeholder-weekday">
          {date.format("dddd")}
        </Badge>
      ) : null}
    </Stack>
  );
};

/**
 * Empty-state view shown when no journal document exists for the given date.
 *
 * Renders the formatted date as a title and a primary "Create" button that
 * calls `JournalService.ensureJournalByDate` to create the document through the
 * existing journal-property path, then opens it in the active workbench view.
 * Guards against double-clicks with a local `redirecting` flag.
 *
 * @param dateString - The date in `JOURNAL_DATE_FORMAT` for which no journal
 *   document exists yet.
 */
export const JournalPlaceholder = ({ dateString }: { dateString: string }) => {
  const t = useI18n();
  const [redirecting, setRedirecting] = useState(false);
  const redirectingRef = useRef(false);
  const workbench = useService(WorkbenchService).workbench;
  const journalService = useService(JournalService);

  const createJournal = useCallback(() => {
    if (redirectingRef.current) return;
    redirectingRef.current = true;
    setRedirecting(true);

    // Journal creation may synchronously initialise an editor document and
    // template data. Running it outside the pointer event keeps the browser
    // input path responsive while the following route/editor readiness checks
    // still verify that creation actually completed.
    window.setTimeout(() => {
      try {
        const doc = journalService.ensureJournalByDate(dateString);
        workbench.openDoc(doc.id, {
          replaceHistory: true,
          at: "active",
        });
      } catch (error) {
        console.error("[journal] create daily journal failed", {
          date: dateString,
          error,
        });
        redirectingRef.current = false;
        setRedirecting(false);
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
              onClick={createJournal}
              disabled={redirecting}
              aria-busy={redirecting}
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
};

/**
 * Full journals workbench view.
 *
 * Acts as a smart redirector: if a journal already exists for the requested
 * date it immediately opens that document via `workbench.openDoc` (replacing
 * the history entry). If no journal exists yet it renders `<JournalPlaceholder>`
 * with the week date picker so the user can navigate to another date or create
 * the journal.
 *
 * Uses `useLayoutEffect` to perform the redirect synchronously before the
 * browser paints, avoiding a flash of the placeholder on navigation to an
 * existing journal date.
 */
export const JournalsPageWithConfirmation = () => {
  const journalService = useService(JournalService);
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const workspace = useService(WorkspaceService).workspace;
  const location = useLiveData(view.location$);
  const dateString = getDateFromUrl(location);
  const journals = useLiveData(journalService.journalsByDate$(dateString));

  const [ready, setReady] = useState(false);

  const openJournal = useCallback(
    (date: string) => {
      workbench.open(`/journals?date=${date}`, { at: "active" });
    },
    [workbench],
  );

  useLayoutEffect(() => {
    // only handle current route
    if (!location.pathname.startsWith("/journals")) return;

    // check if the journal is created
    if (journals.length === 0) {
      // The placeholder route keeps the calendar/event list in the workbench
      // sidebar. Prepare the sidebar before first paint so the create button is
      // not shifted by a post-render panel animation.
      view.showTool("calendar");
      workbench.openContextPanel();
      if (!ready) setReady(true);
      return;
    }

    // if created, redirect to the journal
    const journal = journals[0];
    workbench.openDoc(journal.id, { replaceHistory: true, at: "active" });
  }, [dateString, journals, location.pathname, ready, view, workbench]);

  if (!ready) return null;

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
          onDateChange={openJournal}
        />
      </ViewHeader>
      <ViewBody>
        <JournalPlaceholder dateString={dateString} />
      </ViewBody>
      <JournalContextSurface />
    </>
  );
};

export const Component = () => {
  return <JournalsPageWithConfirmation />;
};
