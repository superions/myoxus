// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import type { UseQueryConfig } from "@myoxus/core/components/hooks/use-query";
import {
  DatabaseFieldKind,
  DatabaseProfileKind,
  DatabaseStatusGroup,
  setDatabaseRowReminderMutation,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { LiveData } from "@myoxus/infra";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { field, record, rows, readyManagedRecord } from "../test-fixtures";
import type { DatabaseRecord, DatabaseRowRecord } from "../types";
import { assistantPackagesFixture } from "../presentation/test-fixtures";
import { AssistantContext, AssistantControlKind } from "@myoxus/graphql";
import {
  DatabaseReminderPresentation,
  DatabaseReminderControl,
} from "./reminder-control";

const mocks = vi.hoisted(() => ({
  deleteTrigger: vi.fn().mockResolvedValue({}),
  error: undefined as Error | undefined,
  isMutating: false,
  ready: true,
  queryConfigs: [] as UseQueryConfig[],
  serverService: { server$: undefined as unknown },
  mutate: vi.fn().mockResolvedValue(undefined),
  reminders: [] as Array<{
    id: string;
    offsetMinutes: number;
    triggerAt: string;
  }>,
  setTrigger: vi.fn().mockResolvedValue({}),
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => mocks.serverService,
}));

vi.mock("@myoxus/core/components/hooks/use-query", () => ({
  useQuery: (_options: unknown, config: UseQueryConfig) => {
    mocks.queryConfigs.push(config);
    return {
      data:
        mocks.error || !mocks.ready
          ? undefined
          : {
              workspace: { databaseRowReminders: mocks.reminders },
            },
      error: mocks.error,
      mutate: mocks.mutate,
    };
  },
}));

vi.mock("@myoxus/core/components/hooks/use-mutation", () => ({
  useMutation: ({ mutation }: { mutation: unknown }) => ({
    isMutating: mocks.isMutating,
    trigger:
      mutation === setDatabaseRowReminderMutation
        ? mocks.setTrigger
        : mocks.deleteTrigger,
  }),
}));

vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } = await import("../test-i18n-mock");
  return createDatabaseTestI18nModule();
});

vi.mock(
  "@myoxus/core/components/hooks/myoxus/use-user-preferences",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@myoxus/core/components/hooks/myoxus/use-user-preferences")
    >()),
    useRegionalPreferences: () => ({
      dateFormat: "locale" as const,
      locale: "en",
      timeFormat: "locale" as const,
      timezone: "UTC",
    }),
  }),
);

const dateTimeField = {
  ...field("field-starts", DatabaseFieldKind.DateTime, "Starts", 2),
  config: {
    ...field("field-starts", DatabaseFieldKind.DateTime, "Starts", 2).config,
    dateTime: { allowReminders: true, defaultTimeZone: "UTC" },
  },
};
const dateTimeRow = {
  ...rows[0]!,
  cells: [
    ...rows[0]!.cells,
    {
      ...rows[0]!.cells[0]!,
      fieldId: dateTimeField.id,
      fieldType: DatabaseFieldKind.DateTime,
      value: {
        ...rows[0]!.cells[0]!.value,
        dateTime: {
          allDay: false,
          end: null,
          start: "2026-07-20T10:00:00Z",
          timeZone: "UTC",
        },
        kind: DatabaseFieldKind.DateTime,
        text: null,
      },
    },
  ],
};
const dateTimeRecord = {
  ...record,
  fields: [...record.fields, dateTimeField],
};

const taskStatusField: DatabaseRecord["fields"][number] = {
  ...field("task-status", DatabaseFieldKind.Status, "Status", 3),
  config: {
    ...dateTimeField.config,
    kind: DatabaseFieldKind.Status,
    status: {
      defaultOptionId: "status.todo",
      options: [
        {
          id: "status.todo",
          name: "Todo",
          colorRole: "database.status.todo",
          group: DatabaseStatusGroup.NotStarted,
          position: 0,
        },
        {
          id: "active",
          name: "Active",
          colorRole: "database.status.inProgress",
          group: DatabaseStatusGroup.Active,
          position: 1,
        },
        {
          id: "status.done",
          name: "Done",
          colorRole: "database.status.done",
          group: DatabaseStatusGroup.Complete,
          position: 2,
        },
        {
          id: "archived",
          name: "Archived",
          colorRole: "database.status.done",
          group: DatabaseStatusGroup.Archived,
          position: 3,
        },
      ],
    },
  },
};

function renderControl() {
  const presentation = assistantPackagesFixture(AssistantContext.TaskDetail)[0]
    .presentation.steps.flatMap((step) =>
      step.groups.flatMap((group) => group.controls),
    )
    .find((control) => control.kind === AssistantControlKind.Reminder);
  const result = render(
    <MyoxusUIProvider>
      <DatabaseReminderControl
        field={dateTimeField}
        record={dateTimeRecord}
        row={dateTimeRow}
      />
    </MyoxusUIProvider>,
    {
      wrapper: ({ children }) => (
        <DatabaseReminderPresentation.Provider value={presentation}>
          {children}
        </DatabaseReminderPresentation.Provider>
      ),
    },
  );
  fireEvent.click(screen.getByTestId("database-reminder-trigger"));
  return result;
}

beforeEach(() => {
  mocks.deleteTrigger.mockClear();
  mocks.setTrigger.mockClear();
  mocks.mutate.mockClear();
  mocks.error = undefined;
  mocks.isMutating = false;
  mocks.ready = true;
  mocks.queryConfigs = [];
  mocks.serverService.server$ = undefined;
  mocks.reminders = [];
});

afterEach(cleanup);

describe("DatabaseReminderControl", () => {
  test.each(["complete"] as const)(
    "%s tasks retain personal removal but cannot schedule a new reminder",
    async () => {
      const statusField = taskStatusField;
      const project: DatabaseRecord = {
        ...dateTimeRecord,
        database: {
          ...record.database,
          profileKind: DatabaseProfileKind.Project,
        },
        fields: [...dateTimeRecord.fields, statusField],
        fieldRoles: [
          {
            databaseId: record.database.id,
            profileKind: DatabaseProfileKind.Project,
            roleKey: "task.status",
            rowKindScope: "task",
            fieldId: statusField.id,
            required: true,
            config: {},
            createdAt: "2026-10-15T00:00:00Z",
            updatedAt: "2026-10-15T00:00:00Z",
          },
        ],
      };
      const task: DatabaseRowRecord = {
        ...dateTimeRow,
        row: {
          ...dateTimeRow.row,
          rowKind: "task",
          deletedAt: null,
        },
        cells: [
          ...dateTimeRow.cells,
          {
            ...dateTimeRow.cells[0]!,
            fieldId: statusField.id,
            fieldType: DatabaseFieldKind.Status,
            value: {
              ...dateTimeRow.cells[0]!.value,
              kind: DatabaseFieldKind.Status,
              status: "status.done",
            },
          },
        ],
      };
      mocks.reminders = [
        {
          id: "existing-personal",
          offsetMinutes: 10,
          triggerAt: "2026-07-20T09:50:00Z",
        },
      ];
      render(
        <MyoxusUIProvider>
          <DatabaseReminderControl
            field={dateTimeField}
            record={readyManagedRecord(project)}
            row={task}
          />
        </MyoxusUIProvider>,
      );
      fireEvent.click(screen.getByTestId("database-reminder-trigger"));
      const newPreset = await screen.findByRole("menuitem", {
        name: /30 minutes before/,
      });
      expect(newPreset.getAttribute("data-disabled")).not.toBeNull();
      fireEvent.click(newPreset);
      expect(
        screen.getByRole<HTMLButtonElement>("button", { name: "Add" }).disabled,
      ).toBe(true);
      expect(mocks.setTrigger).not.toHaveBeenCalled();
      fireEvent.click(
        screen.getByRole("menuitem", { name: /10 minutes before/ }),
      );
      await waitFor(() =>
        expect(mocks.deleteTrigger).toHaveBeenCalledWith({
          input: {
            databaseId: record.database.id,
            reminderId: "existing-personal",
          },
        }),
      );
    },
  );

  test("uses a fresh personal list after status-cell revisions even when the Row revision is unchanged", () => {
    const statusField = taskStatusField;
    const project: DatabaseRecord = {
      ...dateTimeRecord,
      database: {
        ...record.database,
        profileKind: DatabaseProfileKind.Project,
      },
      fields: [...dateTimeRecord.fields, statusField],
      fieldRoles: [
        {
          databaseId: record.database.id,
          profileKind: DatabaseProfileKind.Project,
          roleKey: "task.status",
          rowKindScope: "task",
          fieldId: statusField.id,
          required: true,
          config: {},
          createdAt: "2026-10-15T00:00:00Z",
          updatedAt: "2026-10-15T00:00:00Z",
        },
      ],
    };
    const task = (status: string, revision: number): DatabaseRowRecord => ({
      ...dateTimeRow,
      row: { ...dateTimeRow.row, rowKind: "task" },
      cells: [
        ...dateTimeRow.cells,
        {
          ...dateTimeRow.cells[0]!,
          fieldId: statusField.id,
          fieldType: DatabaseFieldKind.Status,
          editRevision: revision,
          value: {
            ...dateTimeRow.cells[0]!.value,
            kind: DatabaseFieldKind.Status,
            status,
          },
        },
      ],
    });
    mocks.serverService.server$ = new LiveData({
      id: "server",
      baseUrl: "https://example.test",
      account$: new LiveData({ id: "actor" }),
    });
    const surface = (status: string, revision: number) => (
      <MyoxusUIProvider>
        <DatabaseReminderControl
          field={dateTimeField}
          record={readyManagedRecord(project)}
          row={task(status, revision)}
        />
      </MyoxusUIProvider>
    );
    const rendered = render(surface("status.todo", 1));
    const queryKey = () => {
      const next = vi.fn().mockReturnValue({});
      mocks.queryConfigs.at(-1)!.use![0]!(next)(["reminders"], null, {});
      return next.mock.calls[0]![0]();
    };
    const initial = queryKey();
    rendered.rerender(surface("status.done", 2));
    const closed = queryKey();
    rendered.rerender(surface("status.todo", 3));
    const reopened = queryKey();
    expect(closed).not.toEqual(initial);
    expect(reopened).not.toEqual(initial);
    expect(reopened).not.toEqual(closed);
    expect(mocks.setTrigger).not.toHaveBeenCalled();
    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  test("scopes the existing query cache by server and account, including sign-out", async () => {
    const account = new LiveData<{ id: string } | null>({ id: "first-person" });
    mocks.serverService.server$ = new LiveData({
      id: "first-server",
      baseUrl: "https://first.invalid",
      account$: account,
    });
    renderControl();
    const queryKey = () => {
      const next = vi.fn().mockReturnValue({});
      mocks.queryConfigs.at(-1)!.use![0]!(next)(
        () => ["cloud", "reminders", { rowId: "row-1" }],
        null,
        {},
      );
      return next.mock.calls[0]![0]();
    };
    expect(queryKey()).toEqual([
      "first-server",
      "https://first.invalid",
      "first-person",
      ["cloud", "reminders", { rowId: "row-1" }],
    ]);
    act(() => account.next({ id: "second-person" }));
    await waitFor(() => expect(queryKey()[2]).toBe("second-person"));
    act(() => account.next(null));
    await waitFor(() => expect(queryKey()).toBeNull());
  });

  test("keeps loaded toggles blocked after closing and reopening during a mutation", async () => {
    mocks.isMutating = true;
    renderControl();
    const preset = await screen.findByRole("menuitem", {
      name: /10 minutes before/,
    });
    expect(preset.getAttribute("data-disabled")).not.toBeNull();
    fireEvent.click(preset);
    const user = userEvent.setup();
    await user.keyboard("{Escape}");
    fireEvent.click(screen.getByTestId("database-reminder-trigger"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /10 minutes before/ }),
    );
    expect(mocks.setTrigger).not.toHaveBeenCalled();
    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  test("changing row identity clears old actionable presets while the new read is pending", async () => {
    mocks.reminders = [
      {
        id: "reminder-old",
        offsetMinutes: 10,
        triggerAt: "2026-07-20T09:50:00Z",
      },
    ];
    const rendered = renderControl();
    expect(
      await screen.findByRole("menuitem", { name: /10 minutes before/ }),
    ).not.toBeNull();
    mocks.ready = false;
    rendered.rerender(
      <MyoxusUIProvider>
        <DatabaseReminderControl
          field={dateTimeField}
          record={dateTimeRecord}
          row={{ ...dateTimeRow, row: { ...dateTimeRow.row, id: "row-next" } }}
        />
      </MyoxusUIProvider>,
    );
    expect(await screen.findByRole("status")).not.toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: /10 minutes before/ }),
    ).toBeNull();
    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  test("removes the trigger tooltip while the Reminder Menu is open", async () => {
    const user = userEvent.setup();
    render(
      <MyoxusUIProvider env="test">
        <DatabaseReminderControl
          field={dateTimeField}
          record={dateTimeRecord}
          row={dateTimeRow}
        />
      </MyoxusUIProvider>,
    );

    const trigger = screen.getByTestId("database-reminder-trigger");
    await user.hover(trigger);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Personal reminders",
    );

    await user.click(trigger);
    expect(await screen.findByText("Custom offset")).not.toBeNull();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  test("lists arbitrary custom reminders from server triggerAt and removes one explicitly", async () => {
    mocks.reminders = [
      {
        id: "reminder-custom",
        offsetMinutes: 125,
        triggerAt: "2026-07-20T07:55:00Z",
      },
    ];
    renderControl();

    expect(await screen.findByText(/125/)).not.toBeNull();
    expect(
      (screen.getByLabelText("Custom offset") as HTMLInputElement).value,
    ).toBe("120 min");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove reminder",
      }),
    );
    await waitFor(() =>
      expect(mocks.deleteTrigger).toHaveBeenCalledWith({
        input: {
          databaseId: "database-1",
          reminderId: "reminder-custom",
        },
      }),
    );
  });

  test("custom Add stays an idempotent set command and never toggles an existing reminder", async () => {
    mocks.reminders = [
      {
        id: "reminder-existing",
        offsetMinutes: 120,
        triggerAt: "2026-07-20T08:00:00Z",
      },
    ];
    renderControl();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Add",
      }),
    );
    await waitFor(() =>
      expect(mocks.setTrigger).toHaveBeenCalledWith({
        input: {
          databaseId: "database-1",
          fieldId: dateTimeField.id,
          offsetMinutes: 120,
          rowId: "row-1",
        },
      }),
    );
    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  test("blocks invalid and duplicate pending custom submissions before mutation", async () => {
    mocks.isMutating = true;
    renderControl();
    const input = await screen.findByLabelText("Custom offset");
    fireEvent.change(input, { target: { value: "-1" } });
    const add = screen.getByRole<HTMLButtonElement>("button", {
      name: "Add",
    });
    expect(add.disabled).toBe(true);
    fireEvent.click(add);
    expect(mocks.setTrigger).not.toHaveBeenCalled();
    expect(mocks.deleteTrigger).not.toHaveBeenCalled();
  });

  test("replaces reminder controls with a retryable query failure state", async () => {
    mocks.error = new Error("offline");
    renderControl();

    expect(
      await screen.findByText(
        "Personal reminders are temporarily unavailable.",
      ),
    ).not.toBeNull();
    expect(screen.queryByLabelText("Custom offset")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.mutate).toHaveBeenCalled());
  });
});
