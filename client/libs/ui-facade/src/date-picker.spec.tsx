// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import "dayjs/locale/de";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  DatePicker,
  DatePickerDayContent,
  LocalizedDateInput,
  LocalizedDateTimeInput,
  Modal,
  MiniCalendar,
  WeekDatePicker,
} from "./index";
import { MyoxusUIProvider } from "./provider";

describe("facade date picker semantics", () => {
  afterEach(() => cleanup());

  test("keeps day buttons owned by the primitive while allowing custom day attrs", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-17"
          customDayRenderer={(cell) => <span>{cell.label}</span>}
          dayButtonProps={(cell) => ({
            "aria-label": `Day ${cell.label}`,
            "data-is-date-cell": true,
            "data-selected": cell.selected,
          })}
        />
      </MyoxusUIProvider>,
    );

    const dayButtons = screen.getAllByTestId("date-picker-day");
    expect(dayButtons).toHaveLength(42);
    expect(
      dayButtons.every(
        (button) =>
          button.dataset.myoxusUiRole === "button:calendar-month-cell",
      ),
    ).toBe(true);
    expect(dayButtons.some((button) => button.querySelector("button"))).toBe(
      false,
    );
    expect(
      dayButtons.every((button) => !button.hasAttribute("aria-selected")),
    ).toBe(true);
    expect(
      screen.getByRole("button", { name: "May 2026" }).dataset.myoxusUiRole,
    ).toBe("button:calendar-title");
    expect(
      screen.getByRole("button", { name: "May 2026" }).className,
    ).toContain("mantine-UnstyledButton-root");
    expect(
      screen.getByRole("button", { name: "Today" }).dataset.myoxusUiRole,
    ).toBe("button:calendar-today-link");
    expect(screen.getByRole("button", { name: "Today" }).className).toContain(
      "mantine-UnstyledButton-root",
    );
    expect(
      dayButtons.every((button) =>
        button.className.includes("mantine-UnstyledButton-root"),
      ),
    ).toBe(true);
  });

  test("allows dense host panels to hide the today shortcut without changing month cells", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker value="2026-05-17" showTodayLink={false} />
      </MyoxusUIProvider>,
    );

    expect(screen.queryByTestId("date-picker-today")).toBeNull();
    expect(screen.getAllByTestId("date-picker-day")).toHaveLength(42);
    expect(
      screen.getByRole("button", { name: "May 2026" }).dataset.myoxusUiRole,
    ).toBe("button:calendar-title");
  });

  test("renders day indicators and outline selection through facade day content", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-17"
          selectionVariant="outline"
          customDayRenderer={(cell) => (
            <DatePickerDayContent
              indicator={cell.label === "17"}
              indicatorColor={cell.label === "17" ? "rgb(12, 34, 56)" : null}
            >
              {cell.label}
            </DatePickerDayContent>
          )}
        />
      </MyoxusUIProvider>,
    );

    const selectedDay = screen
      .getAllByTestId("date-picker-day")
      .find((button) => button.textContent === "17");
    const dayContent = selectedDay?.querySelector(
      "[data-myoxus-ui-role='calendar-day-content']",
    ) as HTMLElement | null;
    const indicator = selectedDay?.querySelector(
      "[data-myoxus-ui-role='calendar-day-indicator-dot']",
    ) as HTMLElement | null;

    expect(selectedDay?.dataset.selectionVariant).toBe("outline");
    expect(selectedDay?.dataset.selected).toBe("true");
    expect(
      screen
        .getAllByTestId("date-picker-day")
        .filter((button) => button.dataset.selected === "true"),
    ).toHaveLength(1);
    expect(dayContent?.className).toContain(
      "myoxus-ui-date-picker-day-content",
    );
    expect(indicator?.className).toContain(
      "myoxus-ui-date-picker-day-indicator-dot",
    );
    expect(
      dayContent?.style.getPropertyValue(
        "--myoxus-ui-date-picker-day-indicator-color",
      ),
    ).toBe("rgb(12, 34, 56)");
  });

  test("marks week picker days with explicit Myoxus button roles", () => {
    const onChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <WeekDatePicker onChange={onChange} value="2026-05-17" />
      </MyoxusUIProvider>,
    );

    expect(
      screen
        .getAllByTestId("week-picker-day")
        .every(
          (button) =>
            button.dataset.myoxusUiRole === "button:calendar-week-cell",
        ),
    ).toBe(true);
    expect(screen.getAllByRole("radio")).toHaveLength(7);
    expect(document.querySelector(".mantine-SegmentedControl-root")).not.toBe(
      null,
    );
    const nextDay = screen.getAllByRole("radio")[1] as HTMLInputElement;
    fireEvent.click(nextDay);
    expect(onChange).toHaveBeenCalledWith(nextDay.value);
  });

  test("renders week picker labels from the explicit locale contract", () => {
    render(
      <MyoxusUIProvider>
        <WeekDatePicker value="2026-05-19" weekDays="So,Mo,Di,Mi,Do,Fr,Sa" />
      </MyoxusUIProvider>,
    );

    const labels = screen
      .getAllByTestId("week-picker-day")
      .map((button) => button.textContent ?? "");
    expect(labels.join(" ")).toContain("Di");
    expect(labels.join(" ")).not.toContain("Tue");
  });

  test("passes explicit Sunday week start through Mantine Dates", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-19"
          firstDayOfWeek="sunday"
          weekDays="So,Mo,Di,Mi,Do,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const weekdayLabels = screen
      .getAllByText(/^(Mo|Di|Mi|Do|Fr|Sa|So)$/)
      .map((node) => node.textContent);
    expect(weekdayLabels.slice(0, 7)).toEqual([
      "So",
      "Mo",
      "Di",
      "Mi",
      "Do",
      "Fr",
      "Sa",
    ]);
    expect(screen.getAllByTestId("date-picker-day")[0].textContent).toContain(
      "26",
    );
  });

  test("separates localized labels from the configured month week start", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-19"
          firstDayOfWeek="monday"
          weekDays="So,Mo,Di,Mi,Do,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const weekdayLabels = screen
      .getAllByText(/^(Mo|Di|Mi|Do|Fr|Sa|So)$/)
      .map((node) => node.textContent);
    expect(weekdayLabels.slice(0, 7)).toEqual([
      "Mo",
      "Di",
      "Mi",
      "Do",
      "Fr",
      "Sa",
      "So",
    ]);
    expect(screen.getAllByTestId("date-picker-day")[0].textContent).toContain(
      "27",
    );
  });

  test("passes non-Sunday/Monday week starts through Mantine Dates", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-19"
          firstDayOfWeek={2}
          weekDays="Su,Mo,Tu,We,Th,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const weekdayLabels = screen
      .getAllByText(/^(Su|Mo|Tu|We|Th|Fr|Sa)$/)
      .map((node) => node.textContent);
    expect(weekdayLabels.slice(0, 7)).toEqual([
      "Tu",
      "We",
      "Th",
      "Fr",
      "Sa",
      "Su",
      "Mo",
    ]);
    expect(screen.getAllByTestId("date-picker-day")[0].textContent).toContain(
      "28",
    );
  });

  test("marks Sunday through Mantine weekend semantics while keeping localized labels", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-19"
          firstDayOfWeek="monday"
          weekDays="So,Mo,Di,Mi,Do,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const sunday = screen
      .getAllByTestId("date-picker-day")
      .find((button) => button.textContent === "24");

    expect(sunday?.dataset.weekend).toBe("true");
    expect(sunday?.dataset.currentMonth).toBe("true");
  });

  test("renders Mantine week numbers with legacy Facade hooks", () => {
    render(
      <MyoxusUIProvider>
        <DatePicker
          value="2026-05-19"
          firstDayOfWeek="monday"
          showWeekNumbers
          weekDays="So,Mo,Di,Mi,Do,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const weekNumbers = document.querySelectorAll(
      ".myoxus-ui-date-picker-week-number",
    );

    expect(weekNumbers).toHaveLength(6);
    expect(weekNumbers[0]?.textContent).toBe("18");
  });

  test("uses day-indexed labels plus firstDayOfWeek for week picker layout", () => {
    render(
      <MyoxusUIProvider>
        <WeekDatePicker
          value="2026-05-19"
          firstDayOfWeek="monday"
          weekDays="So,Mo,Di,Mi,Do,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const labels = screen
      .getAllByTestId("week-picker-day")
      .map((button) => button.textContent ?? "");
    expect(labels[0]).toContain("Mo");
    expect(labels[0]).toContain("18");
    expect(labels[1]).toContain("Di");
    expect(labels[1]).toContain("19");
    expect(labels.join(" ")).not.toContain("So17");
  });

  test("supports Mantine DayOfWeek values in the week picker strip", () => {
    render(
      <MyoxusUIProvider>
        <WeekDatePicker
          value="2026-05-19"
          firstDayOfWeek={2}
          weekDays="Su,Mo,Tu,We,Th,Fr,Sa"
        />
      </MyoxusUIProvider>,
    );

    const labels = screen
      .getAllByTestId("week-picker-day")
      .map((button) => button.textContent ?? "");
    expect(labels[0]).toContain("Tu");
    expect(labels[0]).toContain("19");
    expect(labels[1]).toContain("We");
    expect(labels[1]).toContain("20");
    expect(labels[6]).toContain("Mo");
    expect(labels[6]).toContain("25");
  });

  test("uses Mantine MiniCalendar for locale-aware selected-week navigation", () => {
    const changes: string[] = [];
    render(
      <MyoxusUIProvider>
        <MiniCalendar
          value="2026-05-19"
          firstDayOfWeek="monday"
          locale="de"
          numberOfDays={7}
          onChange={(nextValue) => changes.push(nextValue)}
        />
      </MyoxusUIProvider>,
    );

    const labels = screen
      .getAllByTestId("mini-calendar-day")
      .map((button) => button.textContent ?? "");

    expect(labels[0]).toContain("Mo");
    expect(labels[0]).toContain("18");
    expect(labels[1]).toContain("Di");
    expect(labels[1]).toContain("19");
    expect(labels.join(" ")).not.toContain("Sun");
    expect(
      screen.getAllByTestId("mini-calendar-day").filter((button) => {
        return button.dataset.selected === "true";
      }),
    ).toHaveLength(1);

    screen.getByTestId("mini-calendar-next").click();
    expect(changes.at(-1)).toBe("2026-05-26");
  });

  test("renders a localized one-day MiniCalendar without replacing the month picker contract", () => {
    render(
      <MyoxusUIProvider>
        <MiniCalendar
          value="2026-05-19"
          locale="de"
          monthLabelFormat="dddd"
          numberOfDays={1}
        />
      </MyoxusUIProvider>,
    );

    const day = screen.getByTestId("mini-calendar-day");
    expect(day.textContent).toContain("Dienstag");
    expect(day.textContent).toContain("19");
    expect(day.dataset.myoxusUiRole).toBe("button:calendar-mini-day");
  });

  test("renders localized date and date-time form inputs through Mantine Dates", () => {
    render(
      <MyoxusUIProvider>
        <LocalizedDateInput
          label="Datum"
          locale="de"
          value="2026-06-20"
          onChange={() => undefined}
        />
        <LocalizedDateTimeInput
          label="Start"
          locale="de"
          value="2026-06-20 14:30:00"
          onChange={() => undefined}
        />
      </MyoxusUIProvider>,
    );

    const dateInput = screen.getByLabelText("Datum") as HTMLInputElement;
    const dateTimeInput = screen.getByLabelText("Start") as HTMLButtonElement;

    expect(dateInput.value).toBe("20. Juni 2026");
    expect(dateTimeInput.textContent).toBe("20. Juni 2026 14:30");
    expect(dateInput.value).not.toBe("2026-06-20");
    expect(dateTimeInput.textContent).not.toBe("2026-06-20T14:30");
  });

  test("keeps date-time selection and Escape with its modal while escaping the content scroller", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <MyoxusUIProvider>
        <Modal
          open
          scrollable
          title="Project schedule"
          onOpenChange={onOpenChange}
        >
          <LocalizedDateTimeInput
            label="Meeting time"
            locale="en"
            defaultValue="2026-06-20 14:30:00"
            onChange={onChange}
            // Happy DOM has no layout. Keep the real portal enabled without
            // treating its zero-sized anchor as a detached browser element.
            popoverProps={{
              hideDetached: false,
              transitionProps: { duration: 0 },
            }}
          />
        </Modal>
      </MyoxusUIProvider>,
    );

    const input = await screen.findByLabelText("Meeting time");
    await user.click(input);
    const dialog = screen.getByRole("dialog", { name: "Project schedule" });
    const selectedDay = await screen.findByRole("button", {
      name: "21 June 2026",
    });
    expect(selectedDay.closest("[data-myoxus-modal-portal]")).toBe(
      dialog.closest("[data-myoxus-modal-portal]"),
    );
    expect(dialog.contains(selectedDay)).toBe(false);
    await user.click(selectedDay);
    expect(onChange).toHaveBeenLastCalledWith("2026-06-21 14:30:00");
    await user.click(await screen.findByRole("button", { name: "Confirm" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "21 June 2026" })).toBeNull(),
    );
    await user.click(input);
    const hours = await screen.findByRole("spinbutton", {
      name: "common.time.hour",
    });
    await user.click(hours);
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "21 June 2026" })).toBeNull(),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Project schedule" })).toBe(
      dialog,
    );
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  test("supports locale-aware compact formats for dense data cells", () => {
    render(
      <MyoxusUIProvider>
        <LocalizedDateInput
          label="Datum"
          locale="de"
          value="2026-06-20"
          valueFormat="L"
          onChange={() => undefined}
        />
        <LocalizedDateTimeInput
          label="Start"
          locale="de"
          value="2026-06-20 14:30:00"
          valueFormat="L HH:mm"
          onChange={() => undefined}
        />
      </MyoxusUIProvider>,
    );

    expect((screen.getByLabelText("Datum") as HTMLInputElement).value).toBe(
      "20.06.2026",
    );
    expect(screen.getByLabelText("Start").textContent).toBe("20.06.2026 14:30");
  });

  test("uses native Mantine layout instead of measured week-cell sizing", () => {
    render(
      <MyoxusUIProvider>
        <WeekDatePicker data-testid="week-picker" value="2026-05-19" />
      </MyoxusUIProvider>,
    );

    const picker = screen.getByTestId("week-picker");
    expect(picker.className).toContain("mantine-Group-root");
    expect(
      picker
        .querySelector(".mantine-SegmentedControl-root")
        ?.getAttribute("data-full-width"),
    ).not.toBeNull();
  });

  test("normalizes regional Myoxus locales before passing them to Mantine Schedule", () => {
    const source = readFileSync(
      join(process.cwd(), "client/libs/ui-facade/src/data-views/calendar.tsx"),
      "utf8",
    );

    expect(source).toContain(
      "const mantineLocale = normalizeDayjsLocale(locale)",
    );
    expect(source).toContain("<MantineSchedule");
    expect(source).toContain("locale={mantineLocale}");
  });

  test("keeps only month-day exceptions outside native Mantine date controls", () => {
    const css = readFileSync(
      join(process.cwd(), "client/libs/ui-facade/src/date-picker.css"),
      "utf8",
    );
    const source = readFileSync(
      join(process.cwd(), "client/libs/ui-facade/src/date-picker.tsx"),
      "utf8",
    );
    const weekPickerSource = source.slice(
      source.indexOf("export interface WeekDatePickerHandle"),
    );

    expect(css).toContain(".myoxus-ui-date-picker-day-content");
    expect(css).toContain(".myoxus-ui-date-picker-day-indicator");
    expect(css).toContain(".myoxus-ui-date-picker-day-indicator-dot");
    expect(css).toContain(".myoxus-ui-date-picker-day[data-weekend");
    expect(css).toContain('data-selection-variant="outline"');
    expect(css).not.toContain(".myoxus-ui-week-date-picker");
    expect(css).not.toContain("--myoxus-ui-week-date-picker-min-day-width");
    expect(source).toContain("<MantineDatePicker");
    expect(source).toContain("<MantineMiniCalendar");
    expect(weekPickerSource).toContain("<SegmentedControl");
    expect(weekPickerSource).toContain("<Group");
    expect(weekPickerSource).not.toContain("observeResize");
    expect(weekPickerSource).not.toContain("getComputedStyle");
    expect(weekPickerSource).not.toContain("minDayWidth");
    expect(weekPickerSource).not.toContain("navButtonSize");
    expect(source).toContain('data-myoxus-ui-role="calendar-month-picker"');
    expect(source).toContain('data-myoxus-ui-role="calendar-mini"');
    expect(source).not.toContain("myoxus-ui-date-picker-calendar");
    expect(source).not.toContain("myoxus-ui-date-picker-header");
    expect(source).not.toContain("myoxus-ui-date-picker-title");
    expect(source).not.toContain("myoxus-ui-date-picker-today");
    expect(source).not.toContain("myoxus-ui-mini-calendar");
    expect(source).not.toContain('"--myoxus-ui-date-picker-gap-x"');
    expect(source).not.toContain('"--myoxus-ui-date-picker-cell-size"');
    expect(css).not.toContain("height: 16px;");
    expect(css).not.toContain("line-height: 16px;");
    expect(css).not.toMatch(/\b\d+(?:\.\d+)?px\b/);
    expect(css).not.toContain(".myoxus-ui-mini-calendar");
    expect(css).not.toContain(".myoxus-ui-date-picker-header");
    expect(css).not.toContain(".myoxus-ui-date-picker-month");
  });
});
