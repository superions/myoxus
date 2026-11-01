// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import "../test-editor-boundary";

import {
  AssistantActionKind,
  AssistantContext,
  AssistantInputTarget,
  AssistantValueType,
  DatabaseFieldKind,
  DatabaseProfileKind,
  DatabaseSystemRole,
  databaseSchemaQuery,
  type AssistantPackageFragmentFragment,
} from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { field, record, readyManagedRecord, TIMESTAMP } from "../test-fixtures";
import { assistantPackagesFixture } from "../presentation/test-fixtures";
import { assistantValue } from "../presentation/values";

const state = vi.hoisted(() => ({
  gql: vi.fn(),
  submit: vi.fn(),
  phase: "draft" as "draft" | "uncertain",
  descriptor: null as AssistantPackageFragmentFragment | null,
}));
vi.mock("./use-workspace-tasks", () => ({
  useTaskIdentity: () => ({
    identity: "server/actor/workspace",
    server: { gql: state.gql },
    workspace: { id: "workspace-1" },
    account: { id: "actor" },
    availability: { status: "available" },
  }),
}));
vi.mock("../presentation/use-assistant-presentation", () => ({
  useAssistantPresentation: () => ({
    descriptor: state.descriptor,
    invalidated: false,
    isLoading: false,
    mutate: vi.fn(),
  }),
}));
vi.mock("./use-create-task", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./use-create-task")>()),
  useCreateTask: () => ({
    phase: state.phase,
    submit: state.submit,
    failure: null,
    candidates: [],
    review: vi.fn(),
    checking: false,
    reviewFailed: false,
    checked: false,
    allowAnotherAttempt: vi.fn(),
  }),
}));
vi.mock("@myoxus/core/components/member-selector", () => ({
  MemberSelectorInline: ({
    onChange,
    readonly,
  }: {
    onChange: (ids: string[]) => void;
    readonly?: boolean;
  }) => (
    <button
      type="button"
      disabled={readonly}
      onClick={() => onChange(["other-member"])}
    >
      Choose assignee
    </button>
  ),
}));
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({ timezone: "Europe/Berlin" }),
}));
vi.mock("@myoxus/i18n", async () =>
  (await import("../test-i18n-mock")).createDatabaseTestI18nModule(),
);
import { NewTaskModal } from "./new-task-modal";

const description = field(
  "description-native",
  DatabaseFieldKind.RichText,
  "Description",
  1,
);
const due = field("due-native", DatabaseFieldKind.DateTime, "Due", 2);
due.config.dateTime = { defaultTimeZone: "UTC", allowReminders: true };
const assignees = field(
  "assignees-native",
  DatabaseFieldKind.Users,
  "Assignees",
  3,
);
const schema = readyManagedRecord({
  ...record,
  database: {
    ...record.database,
    profileKind: DatabaseProfileKind.Project,
    systemRole: DatabaseSystemRole.WorkspaceTasks,
  },
  fields: [...record.fields, description, due, assignees],
  fieldRoles: (
    [
      ["task.description", description.id],
      ["task.dueDate", due.id],
      ["task.assignees", assignees.id],
    ] as const
  ).map(([roleKey, fieldId]) => ({
    databaseId: record.database.id,
    profileKind: DatabaseProfileKind.Project,
    roleKey,
    fieldId,
    rowKindScope: "task",
    required: true,
    config: {},
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  })),
});
schema.managedSchema!.canEditMetadata = false;
schema.managedSchema!.canManageLifecycle = false;
const destination = {
  id: schema.database.id,
  databaseId: schema.database.id,
  title: "Workspace Tasks",
  workspaceTasks: true,
  editRevision: 1,
  managedSchema: schema.managedSchema!,
};
function nativeForm() {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MyoxusUIProvider env="test">
        <NewTaskModal
          open
          projects={[destination]}
          destinationsUnavailable={false}
          projectsLoading={false}
          projectsError={false}
          onRetryProjects={vi.fn()}
          returnToHome={false}
          onClose={vi.fn()}
          onCreated={vi.fn()}
          onOpenTask={vi.fn()}
          onOpenProject={vi.fn()}
          returnFocusRef={createRef()}
        />
      </MyoxusUIProvider>
    </SWRConfig>
  );
}
function mount() {
  return render(nativeForm());
}
beforeEach(() => {
  state.descriptor = structuredClone(
    assistantPackagesFixture(AssistantContext.TaskCreation)[0],
  );
  state.phase = "draft";
  state.submit.mockReset();
  state.gql.mockReset().mockImplementation(async ({ query }) => {
    if (query === databaseSchemaQuery)
      return { workspace: { database: schema } };
    throw new Error("Unexpected native Task form read");
  });
});
afterEach(cleanup);

test("file-required Due and Assignees block the native consuming form with field feedback", async () => {
  for (const input of state.descriptor!.inputs)
    if (
      [AssistantInputTarget.Due, AssistantInputTarget.Assignees].includes(
        input.target,
      )
    )
      input.required = true;
  mount();
  const user = userEvent.setup();
  await user.type(
    await screen.findByLabelText("Title"),
    "Required native fields",
  );
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Create" }) as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(state.submit).not.toHaveBeenCalled();
  expect(
    screen
      .getByText("Assignees is required.")
      .checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  ).toBe(true);
  expect(
    within(
      screen
        .getByRole("textbox", { name: "Due date" })
        .closest('[data-myoxus-ui-role="form-row"]') as HTMLElement,
    )
      .getByText("Due date is required.")
      .checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  ).toBe(true);
  await user.click(screen.getByRole("button", { name: "Choose assignee" }));
  await user.click(screen.getByRole("button", { name: "Create" }));
  expect(state.submit).not.toHaveBeenCalled();
  expect(screen.queryByText("Assignees is required.")).toBeNull();
  expect(
    within(
      screen
        .getByRole("textbox", { name: "Due date" })
        .closest('[data-myoxus-ui-role="form-row"]') as HTMLElement,
    )
      .getByText("Due date is required.")
      .checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
  ).toBe(true);
});

test("initial multiline description and a source all-day default retain native content and instant", async () => {
  state.descriptor!.inputs.find(
    (input) => input.target === AssistantInputTarget.Due,
  )!.defaultValue = assistantValue(AssistantValueType.DateTime, {
    dateTime: {
      start: "2026-07-20T04:00:00Z",
      end: null,
      allDay: true,
      timeZone: "America/New_York",
    },
  });
  mount();
  const user = userEvent.setup();
  const title = await screen.findByLabelText("Title");
  await user.type(title, "Timezone");
  await user.type(
    screen.getByLabelText("Description (optional)"),
    "First line{Enter}{Enter}Final line",
  );
  await user.click(title);
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Create" }) as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  await user.keyboard("{Enter}");
  await waitFor(() => expect(state.submit).toHaveBeenCalledOnce());
  expect(state.submit).toHaveBeenCalledWith({
    title: "Timezone",
    templateId: "",
    cells: [
      {
        fieldId: description.id,
        value: {
          richText: {
            document: {
              type: "doc",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "First line" }],
                },
                { type: "paragraph" },
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Final line" }],
                },
              ],
            },
          },
        },
      },
      {
        fieldId: due.id,
        value: {
          dateTime: {
            start: "2026-07-20T04:00:00.000Z",
            end: null,
            allDay: true,
            timeZone: "America/New_York",
          },
        },
      },
    ],
  });
});

test("a locked native confirmation disables assignees and due inputs outside the fieldset", async () => {
  state.descriptor!.inputs.find(
    (input) => input.target === AssistantInputTarget.Due,
  )!.defaultValue = assistantValue(AssistantValueType.DateTime, {
    dateTime: {
      start: "2026-07-20T00:00:00Z",
      end: null,
      allDay: true,
      timeZone: "UTC",
    },
  });
  const descriptor = state.descriptor!;
  const create = descriptor.presentation.steps
    .flatMap((step) => step.actions)
    .find((action) => action.action === AssistantActionKind.CreateTask)!;
  const assigneesInput = descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.Assignees,
  )!;
  assigneesInput.required = true;
  descriptor.inputs.find(
    (input) => input.target === AssistantInputTarget.Due,
  )!.required = true;
  const portalTargets = new Set([
    AssistantInputTarget.Assignees,
    AssistantInputTarget.Due,
  ]);
  const portalIds = new Set(
    descriptor.inputs
      .filter((input) => portalTargets.has(input.target))
      .map((input) => input.id),
  );
  const groups = descriptor.presentation.steps.flatMap((step) => step.groups);
  const portalGroups = groups
    .map((group) => ({
      ...group,
      controls: group.controls.filter(
        (control) => control.input && portalIds.has(control.input),
      ),
    }))
    .filter((group) => group.controls.length);
  for (const step of descriptor.presentation.steps) {
    for (const group of step.groups)
      group.controls = group.controls.filter(
        (control) => !control.input || !portalIds.has(control.input),
      );
    step.actions = step.actions.map((action) =>
      action.action === AssistantActionKind.CreateTask
        ? { ...action, dialog: "native-confirm" }
        : action,
    );
  }
  descriptor.presentation.dialogs = [
    {
      id: "native-confirm",
      title: {
        en: "Native confirmation",
        de: "Bestätigung",
        fr: "Confirmation",
        es: "Confirmación",
      },
      groups: portalGroups,
      actions: [create],
    },
  ];
  const view = mount();
  const user = userEvent.setup();
  await user.type(await screen.findByLabelText("Title"), "Locked portal draft");
  await waitFor(() =>
    expect(
      (screen.getByRole("button", { name: "Create" }) as HTMLInputElement)
        .disabled,
    ).toBe(false),
  );
  await user.click(screen.getByRole("button", { name: "Create" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Native confirmation",
  });
  const portal = within(dialog);
  state.phase = "uncertain";
  view.rerender(nativeForm());
  expect(
    (
      portal.getByRole("button", {
        name: "Choose assignee",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true);
  state.phase = "draft";
  view.rerender(nativeForm());
  const allDaySwitch = portal.getByRole("switch", { name: "All day" });
  const dueEditor = within(
    allDaySwitch.closest('[data-myoxus-ui-role="form-row"]') as HTMLElement,
  );
  expect(
    (dueEditor.getByLabelText("Due date") as HTMLInputElement).disabled,
  ).toBe(false);
  state.phase = "uncertain";
  view.rerender(nativeForm());
  expect(
    (dueEditor.getByLabelText("Due date") as HTMLInputElement).disabled,
  ).toBe(true);
  expect((allDaySwitch as HTMLInputElement).disabled).toBe(true);
  expect(state.submit).not.toHaveBeenCalled();
});
