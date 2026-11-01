// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
import dayjs, { type Dayjs } from "dayjs";
import localeData from "dayjs/plugin/localeData";
import localizedFormat from "dayjs/plugin/localizedFormat";
import {
  type ButtonHTMLAttributes,
  type ReactNode,
  type ComponentProps,
  type CSSProperties,
  type PropsWithChildren,
  type HTMLAttributes,
  useMemo,
  useState,
  useEffect,
  useCallback,
  type ForwardedRef,
  forwardRef,
  useImperativeHandle,
} from "react";
import {
  DateInput as MantineDateInput,
  DateTimePicker as MantineDateTimePicker,
  type DayOfWeek,
  type DateTimePickerProps as MantineDateTimePickerProps,
  DatesProvider,
  DatePicker as MantineDatePicker,
  MiniCalendar as MantineMiniCalendar,
} from "@mantine/dates";
import { joinClassName } from "./helpers/class-name";
import { mergeStyles } from "./css-utils";
import { Stack, Box, Group, SegmentedControl } from "@mantine/core";
import { ArrowRightSmallIcon, ArrowLeftSmallIcon } from "@myoxus/icons/react";
import { useI18n } from "@myoxus/i18n";
import { Button, IconButton } from "./button";
import { useIsInsideModal } from "./modal";

dayjs.extend(localeData);

dayjs.extend(localizedFormat);

export interface DateCell {
  date: Dayjs;
  label: string;
  isToday: boolean;
  notCurrentMonth: boolean;
  selected?: boolean;
  focused?: boolean;
}

export type DatePickerDayButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "key" | "onClick" | "type"
> & {
  "data-myoxus-ui-role"?: string;
};

export interface DatePickerProps {
  value?: string;
  format?: string;
  selectionVariant?: "filled" | "outline";
  firstDayOfWeek?: DatePickerFirstDayOfWeek;
  weekDays?: string;
  showWeekNumbers?: boolean;
  monthNames?: string;
  todayLabel?: string;
  showTodayLink?: boolean;
  customDayRenderer?: (cell: DateCell) => ReactNode;
  dayButtonProps?: (cell: DateCell) => DatePickerDayButtonProps;
  onChange?: (value: string) => void;
  onCursorChange?: (cursor: Dayjs) => void;
  monthHeaderCellClassName?: string;
  monthBodyCellClassName?: string;
}

type MantineDateInputComponentProps = ComponentProps<typeof MantineDateInput>;

type MantineDateTimePickerComponentProps =
  MantineDateTimePickerProps<"default">;

export interface LocalizedDateInputProps extends Omit<
  MantineDateInputComponentProps,
  "locale" | "size" | "valueFormat" | "variant"
> {
  locale?: string;
  valueFormat?: string;
}

export interface LocalizedDateTimeInputProps extends Omit<
  MantineDateTimePickerComponentProps,
  "locale" | "size" | "valueFormat" | "variant"
> {
  locale?: string;
  valueFormat?: string;
}

export type DatePickerFirstDayOfWeek = DayOfWeek | "sunday" | "monday";

type DatePickerDayContentStyle = CSSProperties & {
  "--myoxus-ui-date-picker-day-indicator-color"?: string;
};

export function DatePickerDayContent({
  children,
  className,
  style,
  indicator = false,
  indicatorColor,
  "data-myoxus-ui-role": uiRole = "calendar-day-content",
  ...props
}: PropsWithChildren<
  HTMLAttributes<HTMLSpanElement> & {
    indicator?: boolean;
    indicatorColor?: string | null;
    "data-myoxus-ui-role"?: string;
  }
>) {
  // The month-cell indicator is owned by the DatePicker facade so Journal and
  // future calendar surfaces do not recreate absolute dot positioning in
  // product CSS. Product code supplies only event presence and optional color.
  const indicatorStyle: DatePickerDayContentStyle | undefined = indicatorColor
    ? { "--myoxus-ui-date-picker-day-indicator-color": indicatorColor }
    : undefined;

  return (
    <span
      {...props}
      className={joinClassName("myoxus-ui-date-picker-day-content", className)}
      style={mergeStyles(indicatorStyle, style)}
      data-myoxus-ui-role={uiRole}
    >
      <span className="myoxus-ui-date-picker-day-label">{children}</span>
      {indicator ? (
        <span
          className="myoxus-ui-date-picker-day-indicator"
          data-myoxus-ui-role="calendar-day-indicator"
        >
          <span
            className="myoxus-ui-date-picker-day-indicator-dot"
            data-myoxus-ui-role="calendar-day-indicator-dot"
          />
        </span>
      ) : null}
    </span>
  );
}

const datePickerFormat = "YYYY-MM-DD";

const dayjsLocaleAliases: Record<string, string> = {
  "el-gr": "el",
  "es-ar": "es",
  "es-cl": "es",
  "nb-no": "nb",
  "sv-se": "sv",
  "zh-hans": "zh-cn",
  "zh-hant": "zh-tw",
};

export function normalizeDayjsLocale(locale?: string): string | undefined {
  const normalized = locale?.trim().toLowerCase();
  if (!normalized) return undefined;
  return dayjsLocaleAliases[normalized] ?? normalized;
}

function localizedWeekDays(): string[] {
  try {
    return dayjs.weekdaysShort();
  } catch {
    return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  }
}

function parseWeekdayLabels(weekDays?: string): string[] {
  // Keep the label contract aligned with Mantine Dates `weekdayFormat`:
  // labels are indexed by `dayjs().day()`/JavaScript day numbers
  // (Sunday = 0), while `firstDayOfWeek` controls visual ordering.
  return (weekDays ? weekDays.split(",") : localizedWeekDays()).map((label) =>
    label.trim(),
  );
}

function defaultFirstDayOfWeek(): DayOfWeek {
  try {
    const firstDay = dayjs.localeData().firstDayOfWeek();
    return firstDay >= 0 && firstDay <= 6 ? (firstDay as DayOfWeek) : 0;
  } catch {
    return 0;
  }
}

function normalizeFirstDayOfWeek(
  firstDayOfWeek: DatePickerFirstDayOfWeek | undefined,
  fallback = defaultFirstDayOfWeek(),
): DayOfWeek {
  if (firstDayOfWeek === "sunday" || firstDayOfWeek === 0) return 0;
  if (firstDayOfWeek === "monday" || firstDayOfWeek === 1) return 1;
  if (
    typeof firstDayOfWeek === "number" &&
    firstDayOfWeek >= 0 &&
    firstDayOfWeek <= 6
  ) {
    return firstDayOfWeek as DayOfWeek;
  }
  return fallback;
}

function startOfWeekByFirstDay(date: Dayjs, firstDayOfWeek: DayOfWeek): Dayjs {
  const offset = (date.day() - firstDayOfWeek + 7) % 7;
  return date.subtract(offset, "day").startOf("day");
}

function labelForWeekday(day: Dayjs, weekDayList: string[]): string {
  return weekDayList[day.day()] ?? "";
}

function defaultMonthNames(): string {
  return [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ].join(",");
}

function parseDatePickerValue(value?: string, format = datePickerFormat) {
  if (!value) return dayjs();
  const parsed = dayjs(value, format);
  return parsed.isValid() ? parsed : dayjs(value);
}

function defaultDateInputFormat(): string {
  return "LL";
}

function defaultDateTimeInputFormat(): string {
  return `${defaultDateInputFormat()} HH:mm`;
}

export function LocalizedDateInput({
  locale,
  valueFormat,
  popoverProps,
  "data-myoxus-ui-role": uiRole = "calendar-date-input",
  ...props
}: LocalizedDateInputProps & { "data-myoxus-ui-role"?: string }) {
  const mantineLocale = normalizeDayjsLocale(locale);
  const t = useI18n();
  const insideModal = useIsInsideModal();
  const [calendarOpened, setCalendarOpened] = useState(
    popoverProps?.opened ?? false,
  );

  return (
    <MantineDateInput
      {...props}
      allowDeselect={props.allowDeselect ?? false}
      data-myoxus-ui-role={uiRole}
      // Modal checks this marker before DateInput handles Escape itself.
      // Calendar days prevent focus; leaving the input closes it via native blur.
      data-mantine-stop-propagation={
        (insideModal && calendarOpened) || undefined
      }
      locale={mantineLocale}
      previousLabel={props.previousLabel ?? t["common.previous"]()}
      nextLabel={props.nextLabel ?? t["common.next"]()}
      popoverProps={{
        withinPortal: !insideModal,
        ...popoverProps,
        onOpen: () => {
          setCalendarOpened(true);
          popoverProps?.onOpen?.();
        },
        onClose: () => {
          setCalendarOpened(false);
          popoverProps?.onClose?.();
        },
      }}
      size="sm"
      valueFormat={valueFormat ?? defaultDateInputFormat()}
      variant="default"
    />
  );
}

export function LocalizedDateTimeInput({
  locale,
  valueFormat,
  popoverProps,
  "data-myoxus-ui-role": uiRole = "calendar-datetime-input",
  ...props
}: LocalizedDateTimeInputProps & { "data-myoxus-ui-role"?: string }) {
  const mantineLocale = normalizeDayjsLocale(locale);
  const t = useI18n();
  const insideModal = useIsInsideModal();

  return (
    <MantineDateTimePicker
      {...props}
      data-myoxus-ui-role={uiRole}
      dropdownType="popover"
      locale={mantineLocale}
      previousLabel={props.previousLabel ?? t["common.previous"]()}
      nextLabel={props.nextLabel ?? t["common.next"]()}
      timePickerProps={{
        hoursInputLabel: t["common.time.hour"](),
        minutesInputLabel: t["common.time.minute"](),
        secondsInputLabel: t["common.time.second"](),
        ...props.timePickerProps,
      }}
      submitButtonProps={{
        "aria-label": t["Confirm"](),
        ...props.submitButtonProps,
      }}
      popoverProps={{
        withinPortal: !insideModal,
        ...popoverProps,
      }}
      size="sm"
      valueFormat={valueFormat ?? defaultDateTimeInputFormat()}
      variant="default"
    />
  );
}

export function DatePicker({
  value,
  format = datePickerFormat,
  selectionVariant = "filled",
  firstDayOfWeek: configuredFirstDayOfWeek,
  weekDays,
  monthNames = defaultMonthNames(),
  todayLabel = "Today",
  showWeekNumbers,
  customDayRenderer,
  dayButtonProps,
  showTodayLink = true,
  onChange,
  onCursorChange,
  monthHeaderCellClassName,
  monthBodyCellClassName,
}: DatePickerProps) {
  const selected = useMemo(
    () => (value ? parseDatePickerValue(value, format) : null),
    [format, value],
  );
  const [cursor, setCursor] = useState(() => selected ?? dayjs());
  const monthNameList = monthNames.split(",");
  const rawWeekDayList = parseWeekdayLabels(weekDays);
  const firstDayOfWeek = normalizeFirstDayOfWeek(configuredFirstDayOfWeek);

  useEffect(() => {
    if (selected) setCursor(selected);
  }, [selected]);

  const setCursorAndNotify = useCallback(
    (nextCursor: Dayjs) => {
      setCursor(nextCursor);
      onCursorChange?.(nextCursor);
    },
    [onCursorChange],
  );

  const selectDate = useCallback(
    (date: Dayjs) => {
      onChange?.(date.format(format));
      setCursorAndNotify(date);
    },
    [format, onChange, setCursorAndNotify],
  );

  const createCell = useCallback(
    (dateValue: string): DateCell => {
      const date = parseDatePickerValue(dateValue, datePickerFormat).startOf(
        "day",
      );
      return {
        date,
        focused: date.isSame(cursor, "day"),
        isToday: date.isSame(dayjs(), "day"),
        label: date.format("D"),
        notCurrentMonth: !date.isSame(cursor, "month"),
        selected: Boolean(selected?.isSame(date, "day")),
      };
    },
    [cursor, selected],
  );

  const handleMantineChange = useCallback(
    (nextValue: string | null) => {
      if (!nextValue) return;
      selectDate(parseDatePickerValue(nextValue, datePickerFormat));
    },
    [selectDate],
  );

  const handleMantineCursorChange = useCallback(
    (nextValue: string) => {
      setCursorAndNotify(parseDatePickerValue(nextValue, datePickerFormat));
    },
    [setCursorAndNotify],
  );

  const renderDay = useCallback(
    (dateValue: string) => {
      const cell = createCell(dateValue);
      return customDayRenderer ? (
        customDayRenderer(cell)
      ) : (
        <span>{cell.label}</span>
      );
    },
    [createCell, customDayRenderer],
  );

  const getDayProps = useCallback(
    (dateValue: string) => {
      const cell = createCell(dateValue);
      const {
        className: customDayClassName,
        "data-myoxus-ui-role": customDayRole,
        ...customDayAttrs
      } = dayButtonProps?.(cell) ?? {};
      const dayAttrs = { ...customDayAttrs };

      if (dayAttrs["aria-label"] == null) {
        delete dayAttrs["aria-label"];
      }

      return {
        ...dayAttrs,
        className: joinClassName(monthBodyCellClassName, customDayClassName),
        "data-current-month": String(!cell.notCurrentMonth),
        "data-myoxus-ui-role": customDayRole ?? "button:calendar-month-cell",
        "data-selected": cell.selected ? "true" : undefined,
        "data-selection-variant": selectionVariant,
        "data-testid": "date-picker-day",
        tabIndex: cell.focused ? 0 : -1,
      };
    },
    [createCell, dayButtonProps, monthBodyCellClassName, selectionVariant],
  );

  const weekdayFormat = useCallback(
    (dateValue: string) => {
      const day = parseDatePickerValue(dateValue, datePickerFormat);
      return rawWeekDayList[day.day()] ?? day.format("dd");
    },
    [rawWeekDayList],
  );

  const monthLabelFormat = useCallback(
    (dateValue: string) => {
      const date = parseDatePickerValue(dateValue, datePickerFormat);
      return `${monthNameList[date.month()] ?? date.format("MMM")} ${date.format("YYYY")}`;
    },
    [monthNameList],
  );

  return (
    <Stack
      data-testid="date-picker-calendar"
      data-myoxus-ui-role="calendar-month-picker"
      gap="xs"
      w="fit-content"
    >
      {/* Mantine Dates owns calendar math here: week start, weekend semantics
          and week numbers stay provider/component configuration, while the
          facade only maps Myoxus tokens and legacy product hooks. */}
      <DatesProvider
        settings={{
          consistentWeeks: true,
          firstDayOfWeek,
          locale: dayjs.locale(),
          weekendDays: [0],
        }}
      >
        <MantineDatePicker
          allowDeselect={false}
          attributes={{
            calendarHeader: {
              "data-myoxus-ui-role": "calendar-month-header",
            },
            calendarHeaderControl: {
              "data-myoxus-ui-role": "button:calendar-header-control",
            },
            calendarHeaderLevel: {
              "data-myoxus-ui-role": "button:calendar-title",
            },
            day: {
              "data-myoxus-ui-role": "button:calendar-month-cell",
            },
            month: {
              "data-myoxus-ui-role": "calendar-month-grid",
            },
            monthRow: {
              "data-myoxus-ui-role": "calendar-month-row",
            },
            weekdaysRow: {
              "data-myoxus-ui-role": "calendar-month-weekdays-row",
            },
          }}
          classNames={{
            day: "myoxus-ui-date-picker-day",
            weekNumber: "myoxus-ui-date-picker-week-number",
            weekday: joinClassName(
              "myoxus-ui-date-picker-weekday",
              monthHeaderCellClassName,
            ),
            weekdaysRow: "myoxus-ui-date-picker-weekdays",
          }}
          date={cursor.format(datePickerFormat)}
          firstDayOfWeek={firstDayOfWeek}
          fullWidth={false}
          getDayProps={getDayProps}
          headerControlsOrder={["previous", "level", "next"]}
          hideOutsideDates={false}
          highlightToday={false}
          monthLabelFormat={monthLabelFormat}
          nextIcon={
            <ArrowRightSmallIcon data-testid="date-picker-next-month" />
          }
          nextLabel="Next month"
          onChange={handleMantineChange}
          onDateChange={handleMantineCursorChange}
          previousIcon={
            <ArrowLeftSmallIcon data-testid="date-picker-prev-month" />
          }
          previousLabel="Previous month"
          renderDay={renderDay}
          value={selected?.format(datePickerFormat) ?? null}
          weekdayFormat={weekdayFormat}
          weekendDays={[0]}
          withWeekNumbers={showWeekNumbers}
        />
      </DatesProvider>
      {showTodayLink ? (
        <Button
          type="button"
          data-myoxus-ui-role="button:calendar-today-link"
          data-testid="date-picker-today"
          onClick={() => selectDate(dayjs())}
          size="default"
          variant="plain"
        >
          {todayLabel}
        </Button>
      ) : null}
    </Stack>
  );
}

export interface MiniCalendarProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "onChange"
> {
  value?: string;
  format?: string;
  numberOfDays?: number;
  firstDayOfWeek?: DatePickerFirstDayOfWeek;
  monthLabelFormat?: string;
  previousLabel?: string;
  nextLabel?: string;
  previousTestId?: string;
  nextTestId?: string;
  dayTestId?: string;
  locale?: string;
  layout?: "header" | "sidebar";
  dayButtonProps?: (cell: DateCell) => DatePickerDayButtonProps;
  onChange?: (value: string) => void;
}

export function MiniCalendar({
  value,
  format = datePickerFormat,
  numberOfDays = 7,
  firstDayOfWeek: configuredFirstDayOfWeek,
  monthLabelFormat = "dd",
  previousLabel = "Previous period",
  nextLabel = "Next period",
  previousTestId = "mini-calendar-prev",
  nextTestId = "mini-calendar-next",
  dayTestId = "mini-calendar-day",
  locale,
  layout = "sidebar",
  dayButtonProps,
  onChange,
  className,
  ...attrs
}: MiniCalendarProps) {
  const selected = useMemo(
    () => parseDatePickerValue(value, format).startOf("day"),
    [format, value],
  );
  const mantineLocale = useMemo(() => normalizeDayjsLocale(locale), [locale]);
  const firstDayOfWeek = normalizeFirstDayOfWeek(configuredFirstDayOfWeek);
  // Mantine owns the rendered mini-calendar and locale-specific labels. The
  // facade only anchors seven-day instances to the week that contains the
  // selected day so header and sidebar navigation stay synchronized by date.
  const intervalStart = useMemo(
    () =>
      numberOfDays === 7
        ? startOfWeekByFirstDay(selected, firstDayOfWeek)
        : selected,
    [firstDayOfWeek, numberOfDays, selected],
  );

  const createCell = useCallback(
    (dateValue: string): DateCell => {
      const date = parseDatePickerValue(dateValue, datePickerFormat).startOf(
        "day",
      );
      return {
        date,
        focused: date.isSame(selected, "day"),
        isToday: date.isSame(dayjs(), "day"),
        label: date.format("D"),
        notCurrentMonth: !date.isSame(selected, "month"),
        selected: date.isSame(selected, "day"),
      };
    },
    [selected],
  );

  const selectDate = useCallback(
    (date: Dayjs) => {
      onChange?.(date.format(format));
    },
    [format, onChange],
  );

  const shiftSelectedDate = useCallback(
    (direction: -1 | 1) => {
      selectDate(selected.add(numberOfDays * direction, "day"));
    },
    [numberOfDays, selectDate, selected],
  );

  const getDayProps = useCallback(
    (dateValue: string) => {
      const cell = createCell(dateValue);
      const {
        className: customDayClassName,
        "data-myoxus-ui-role": customDayRole,
        ...customDayAttrs
      } = dayButtonProps?.(cell) ?? {};
      const dayAttrs =
        customDayAttrs as ButtonHTMLAttributes<HTMLButtonElement> &
          Record<string, unknown>;

      return {
        ...dayAttrs,
        className: customDayClassName,
        "aria-label":
          dayAttrs["aria-label"] ?? cell.date.format(datePickerFormat),
        "data-current-month": String(!cell.notCurrentMonth),
        "data-is-today": cell.isToday ? "true" : undefined,
        "data-myoxus-ui-role": customDayRole ?? "button:calendar-mini-day",
        "data-testid": String(dayAttrs["data-testid"] ?? dayTestId),
        "data-value": cell.date.format(datePickerFormat),
        tabIndex: cell.focused ? 0 : -1,
      };
    },
    [createCell, dayButtonProps, dayTestId],
  );

  return (
    <MantineMiniCalendar
      {...attrs}
      className={className}
      date={intervalStart.format(datePickerFormat)}
      data-layout={layout}
      data-myoxus-ui-role="calendar-mini"
      getDayProps={getDayProps}
      locale={mantineLocale}
      monthLabelFormat={monthLabelFormat}
      nextControlProps={{
        "aria-label": nextLabel,
        "data-myoxus-ui-role": "button:calendar-mini-next",
        "data-testid": nextTestId,
      }}
      numberOfDays={numberOfDays}
      onChange={(nextValue) =>
        selectDate(parseDatePickerValue(nextValue, datePickerFormat))
      }
      onNext={() => shiftSelectedDate(1)}
      onPrevious={() => shiftSelectedDate(-1)}
      previousControlProps={{
        "aria-label": previousLabel,
        "data-myoxus-ui-role": "button:calendar-mini-previous",
        "data-testid": previousTestId,
      }}
      value={selected.format(datePickerFormat)}
    />
  );
}

export interface WeekDatePickerHandle {
  setCursor?: (cursor: Dayjs) => void;
}

export interface WeekDatePickerProps extends Omit<
  HTMLAttributes<HTMLDivElement>,
  "className" | "onChange" | "style"
> {
  value?: string;
  onChange?: (value: string) => void;
  handleRef?: ForwardedRef<WeekDatePickerHandle>;
  firstDayOfWeek?: DatePickerFirstDayOfWeek;
  /**
   * Comma separated localized weekday labels indexed like Mantine Dates and
   * `dayjs().day()` (Sunday = 0). `firstDayOfWeek` owns the visible week start.
   */
  weekDays?: string;
}

export const WeekDatePicker = forwardRef<HTMLDivElement, WeekDatePickerProps>(
  function WeekDatePicker(
    {
      value,
      onChange,
      handleRef,
      firstDayOfWeek: configuredFirstDayOfWeek,
      weekDays,
      ...attrs
    },
    ref,
  ) {
    const [cursor, setCursor] = useState(() =>
      value ? parseDatePickerValue(value) : dayjs(),
    );
    const weekDayList = parseWeekdayLabels(weekDays);
    const firstDayOfWeek = normalizeFirstDayOfWeek(configuredFirstDayOfWeek);

    useImperativeHandle(handleRef, () => ({ setCursor }), []);

    useEffect(() => {
      if (value) setCursor(parseDatePickerValue(value));
    }, [value]);

    const allDays = useMemo(
      () =>
        Array.from({ length: 7 }, (_, index) =>
          startOfWeekByFirstDay(cursor, firstDayOfWeek)
            .add(index, "day")
            .startOf("day"),
        ),
      [cursor, firstDayOfWeek],
    );
    const dayOptions = useMemo(
      () =>
        allDays.map((day) => {
          const dateValue = day.format(datePickerFormat);
          return {
            value: dateValue,
            label: (
              <Stack
                component="span"
                align="center"
                gap={0}
                data-active={dateValue === value ? "true" : undefined}
                data-myoxus-ui-role="button:calendar-week-cell"
                data-testid="week-picker-day"
                data-today={day.isSame(dayjs(), "day") ? "true" : undefined}
                data-value={dateValue}
              >
                <Box component="span" visibleFrom="xs">
                  {labelForWeekday(day, weekDayList)}
                </Box>
                <Box component="span" hiddenFrom="xs">
                  {labelForWeekday(day, weekDayList).slice(0, 1)}
                </Box>
                <span>{day.format("D")}</span>
              </Stack>
            ),
          };
        }),
      [allDays, value, weekDayList],
    );

    const moveCursor = useCallback(
      (amount: number) => setCursor((current) => current.add(amount, "week")),
      [],
    );

    return (
      <Group
        ref={ref}
        align="center"
        data-myoxus-ui-role="calendar-week-picker"
        flex={1}
        gap="xs"
        miw={0}
        wrap="nowrap"
        {...attrs}
      >
        <IconButton
          icon={<ArrowLeftSmallIcon />}
          data-testid="week-picker-prev"
          aria-label="Previous week"
          onClick={() => moveCursor(-1)}
        />
        <SegmentedControl
          aria-label="Week days"
          data={dayOptions}
          data-myoxus-ui-role="calendar-week-row"
          flex={1}
          fullWidth
          miw={0}
          onChange={(nextValue) => onChange?.(nextValue)}
          size="xs"
          value={value}
          withItemsBorders={false}
        />
        <IconButton
          icon={<ArrowRightSmallIcon />}
          data-testid="week-picker-next"
          aria-label="Next week"
          onClick={() => moveCursor(1)}
        />
      </Group>
    );
  },
);
