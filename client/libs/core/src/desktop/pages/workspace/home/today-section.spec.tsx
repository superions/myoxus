// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { IntegrationService } from "@myoxus/core/modules/integration";
import { WorkspaceService } from "@myoxus/core/modules/workspace";
import { FrameworkRoot, LiveData, type FrameworkProvider } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { TodaySection } from "./today-section";

const state = vi.hoisted(() => ({
  openJournal: vi.fn(),
  timezone: "UTC",
}));

vi.mock("@myoxus/core/components/hooks/use-journal", () => ({
  useJournalRouteHelper: () => ({ openJournal: state.openJournal }),
}));
vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async () => {
    const {
      formatRegionalCalendarDate,
      formatRegionalDate,
      formatRegionalTime,
    } = await import("@myoxus/core/modules/i18n/regional-format");
    return {
      useRegionalFormatters: () => {
        const preferences = {
          locale: "de",
          timezone: state.timezone,
          dateFormat: "day-month-year" as const,
          timeFormat: "24-hour" as const,
        };
        return {
          formatCalendarDate: (value: string) =>
            formatRegionalCalendarDate(value, preferences),
          formatDate: (value: Date | number | string) =>
            formatRegionalDate(value, preferences),
          formatTime: (value: Date | number | string) =>
            formatRegionalTime(value, preferences),
        };
      },
    };
  },
);
vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } =
    await import("@myoxus/core/modules/database/test-i18n-mock");
  return createDatabaseTestI18nModule();
});

const calendar = {
  upcomingEvents$: () => new LiveData([]),
  loadAccountCalendars: async () => [],
  revalidateWorkspaceCalendars: async () => [],
};
const framework = {
  get: (token: unknown) => {
    if (token === WorkspaceService) return { workspace: { flavour: "cloud" } };
    if (token === IntegrationService) return { calendar };
    throw new Error(`Unexpected service ${String(token)}`);
  },
  getOptional: () => undefined,
} as unknown as FrameworkProvider;

async function mount() {
  render(
    <FrameworkRoot framework={framework}>
      <MyoxusUIProvider env="test">
        <TodaySection />
      </MyoxusUIProvider>
    </FrameworkRoot>,
  );
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TZ", "Europe/Berlin");
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-06T15:00:00Z"));
  state.timezone = "UTC";
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

test.each(["UTC", "America/Los_Angeles"])(
  "the Today card displays and opens the local journal day with account timezone %s",
  async (timezone) => {
    state.timezone = timezone;
    await mount();
    expect(screen.getAllByText("06.11.2026")).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", { name: "Today's journal 06.11.2026" }),
    );
    expect(state.openJournal).toHaveBeenCalledWith("2026-11-06", {
      at: "active",
    });
  },
);

test("a mounted Today card advances its displayed date and journal target at local midnight", async () => {
  vi.setSystemTime(new Date("2026-11-06T22:59:59Z"));
  await mount();
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(screen.queryByText("06.11.2026")).toBeNull();
  expect(screen.getAllByText("07.11.2026")).toHaveLength(2);
  fireEvent.click(
    screen.getByRole("button", { name: "Today's journal 07.11.2026" }),
  );
  expect(state.openJournal).toHaveBeenCalledWith("2026-11-07", {
    at: "active",
  });
});
