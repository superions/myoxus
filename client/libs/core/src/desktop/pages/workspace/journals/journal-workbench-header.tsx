/**
 * Shared journal workbench header.
 *
 * The journals overview and an opened daily note must render the same header
 * chrome. Keeping the MiniCalendar, Today action and shared tools burger in
 * this single component prevents the document-detail route from drifting back
 * toward regular document header controls.
 */
import { WorkbenchToolsHeaderMenuButton } from "@myoxus/core/components/workbench-tools-menu";
import { JOURNAL_DATE_FORMAT } from "@myoxus/core/modules/journal";
import { getFirstDayOfWeek } from "@myoxus/core/modules/journal/dayjs-week-config";
import { ViewIcon, ViewTitle } from "@myoxus/core/modules/workbench";
import { useI18n } from "@myoxus/i18n";
import {
  Button,
  HeaderActionPrioritySlot,
  MiniCalendar,
  WorkbenchHeaderFrame,
} from "@myoxus/ui-facade";
import dayjs from "dayjs";
import { useCallback } from "react";

export interface JournalWorkbenchHeaderProps {
  dateString: string;
  title: string;
  onDateChange: (date: string) => void;
}

export function JournalWorkbenchHeader({
  dateString,
  title,
  onDateChange,
}: JournalWorkbenchHeaderProps) {
  const t = useI18n();
  const todayString = dayjs().format(JOURNAL_DATE_FORMAT);
  const isToday = dateString === todayString;

  const openToday = useCallback(() => {
    onDateChange(todayString);
  }, [onDateChange, todayString]);

  return (
    <>
      <ViewTitle title={title} />
      <ViewIcon icon="journal" />
      <WorkbenchHeaderFrame
        data-testid="journal-workbench-header"
        data-myoxus-ui-role="journal-header-frame"
        title={
          <MiniCalendar
            data-testid="journal-week-picker"
            layout="header"
            value={dateString}
            numberOfDays={7}
            firstDayOfWeek={getFirstDayOfWeek()}
            locale={t.language}
            previousLabel={t["com.myoxus.lastWeek"]()}
            nextLabel={t["com.myoxus.nextWeek"]()}
            onChange={onDateChange}
          />
        }
        right={
          <>
            {!isToday ? (
              <HeaderActionPrioritySlot priority="wide">
                <Button data-testid="journal-today-button" onClick={openToday}>
                  {t["com.myoxus.today"]()}
                </Button>
              </HeaderActionPrioritySlot>
            ) : null}
            <WorkbenchToolsHeaderMenuButton />
          </>
        }
      />
    </>
  );
}
