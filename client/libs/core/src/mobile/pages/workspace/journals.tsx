import {
  getDateFromUrl,
  JournalPlaceholder,
} from "@myoxus/core/desktop/pages/workspace/journals";
import { JournalService } from "@myoxus/core/modules/journal";
import { ViewService, WorkbenchService } from "@myoxus/core/modules/workbench";
import { i18nTime } from "@myoxus/i18n";
import { useLiveData, useService } from "@myoxus/infra";
import { cssVar } from "@myoxus/theme";
import {
  MobileWorkspacePageRoot,
  MobileWorkspacePageTitle,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback, useLayoutEffect, useState } from "react";

import { AppTabs, PageHeader } from "../../components";
import { JournalDatePicker } from "./detail/journal-date-picker";

export const JournalsPageWithConfirmation = () => {
  const journalService = useService(JournalService);
  const workbench = useService(WorkbenchService).workbench;
  const view = useService(ViewService).view;
  const location = useLiveData(view.location$);
  const dateString = getDateFromUrl(location);
  const [ready, setReady] = useState(false);
  const allJournalDates = useLiveData(journalService.allJournalDates$);

  const handleDateChange = useCallback(
    (date: string) => {
      workbench.open(`/journals?date=${date}`, { at: "active" });
    },
    [workbench],
  );

  useLayoutEffect(() => {
    // only handle current route
    if (!location.pathname.startsWith("/journals")) return;

    // check if the journal is created
    const docs = journalService.getJournalsByDate(dateString);
    if (docs.length === 0) {
      setReady(true);
      return;
    }

    // if created, redirect to the journal
    const journal = docs[0];
    workbench.openDoc(journal.id, { replaceHistory: true, at: "active" });
  }, [dateString, journalService, location.pathname, view, workbench]);

  if (!ready) return null;

  return (
    <>
      <MobileWorkspacePageRoot bounded>
        <PageHeader
          variant="workspace"
          bottom={
            <JournalDatePicker
              date={dateString}
              onChange={handleDateChange}
              withDotDates={allJournalDates}
            />
          }
          bottomSpacing="journal-date-picker"
        >
          <MobileWorkspacePageTitle>
            {i18nTime(dayjs(dateString), { absolute: { accuracy: "month" } })}
          </MobileWorkspacePageTitle>
        </PageHeader>
        <JournalPlaceholder dateString={dateString} />
      </MobileWorkspacePageRoot>
      <AppTabs background={cssVar("backgroundPrimaryColor")} />
    </>
  );
};

export const Component = () => {
  return <JournalsPageWithConfirmation />;
};
