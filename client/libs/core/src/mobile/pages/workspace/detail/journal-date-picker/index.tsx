import { getFirstDayOfWeek } from "@myoxus/core/modules/journal/dayjs-week-config";
import { useI18n } from "@myoxus/i18n";
import { CalendarDaysIcon } from "@myoxus/icons/react";
import {
  type DateCell,
  DatePicker,
  DatePickerDayContent,
  IconButton,
  MobileJournalDatePickerFrame,
  Popover,
  PopoverContent,
  PopoverTarget,
  WeekDatePicker,
} from "@myoxus/ui-facade";
import { type HTMLAttributes, useCallback, useMemo, useState } from "react";

export interface JournalDatePickerProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange"
> {
  date: string;
  onChange: (date: string) => void;
  withDotDates: Set<string | null | undefined>;
}
export const JournalDatePicker = ({
  date: selected,
  onChange,
  withDotDates,
  ...attrs
}: JournalDatePickerProps) => {
  const t = useI18n();
  const [monthOpen, setMonthOpen] = useState(false);
  const firstDayOfWeek = getFirstDayOfWeek();
  const journalDates = useMemo(
    () =>
      new Set(
        Array.from(withDotDates).filter(
          (date): date is string => typeof date === "string" && date.length > 0,
        ),
      ),
    [withDotDates],
  );

  const handleDateSelect = useCallback(
    (nextDate: string) => {
      setMonthOpen(false);
      onChange(nextDate);
    },
    [onChange],
  );

  const renderDay = useCallback(
    (cell: DateCell) => {
      const dateKey = cell.date.format("YYYY-MM-DD");

      return (
        <DatePickerDayContent indicator={journalDates.has(dateKey)}>
          {cell.label}
        </DatePickerDayContent>
      );
    },
    [journalDates],
  );

  const dayButtonProps = useCallback(
    (cell: DateCell) => {
      const dateKey = cell.date.format("YYYY-MM-DD");

      return {
        "data-has-journal": journalDates.has(dateKey),
        "data-is-date-cell": true,
        "data-is-today": cell.isToday,
        "data-not-current-month": cell.notCurrentMonth,
        tabIndex: cell.focused ? 0 : -1,
      };
    },
    [journalDates],
  );

  return (
    <MobileJournalDatePickerFrame {...attrs}>
      {/* The mobile header now composes existing Mantine-backed facade
          controls. Week math, visible week start and responsive density stay
          in WeekDatePicker/DatePicker instead of route-local swipe geometry. */}
      <WeekDatePicker
        data-testid="mobile-journal-week-picker"
        firstDayOfWeek={firstDayOfWeek}
        onChange={handleDateSelect}
        value={selected}
        weekDays={t["com.myoxus.common.calendar.week-days"]()}
      />
      <Popover opened={monthOpen} onChange={setMonthOpen} position="bottom-end">
        <PopoverTarget>
          <IconButton
            aria-label={t["com.myoxus.editor.at-menu.date-picker"]()}
            data-myoxus-ui-role="button:mobile-journal-month-picker"
            data-testid="mobile-journal-month-picker-trigger"
            icon={<CalendarDaysIcon />}
            onClick={() => setMonthOpen((open) => !open)}
          />
        </PopoverTarget>
        <PopoverContent>
          <DatePicker
            customDayRenderer={renderDay}
            dayButtonProps={dayButtonProps}
            firstDayOfWeek={firstDayOfWeek}
            monthNames={t["com.myoxus.common.calendar.month-names"]()}
            onChange={handleDateSelect}
            showWeekNumbers
            todayLabel={t["com.myoxus.common.calendar.today"]()}
            value={selected}
            weekDays={t["com.myoxus.common.calendar.week-days"]()}
          />
        </PopoverContent>
      </Popover>
    </MobileJournalDatePickerFrame>
  );
};
