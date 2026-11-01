// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { type AssistantPackageFragmentFragment } from "@myoxus/graphql";

import { GuardService } from "@myoxus/core/modules/permissions";
import { FrameworkRoot, LiveData, type FrameworkProvider } from "@myoxus/infra";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import userEvent from "@testing-library/user-event";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { DashboardTaskSection } from "./task-section";

const state = vi.hoisted(() => ({
  read: vi.fn(),
  canCreate: true,
  descriptor: null as AssistantPackageFragmentFragment | null,
}));
vi.mock("@myoxus/core/modules/database/tasks/use-workspace-tasks", () => ({
  useWorkspaceTasks: (...args: unknown[]) => state.read(...args),
}));
vi.mock(
  "@myoxus/core/modules/database/presentation/use-assistant-presentation",
  async () => {
    const { assistantPackagesFixture } =
      await import("@myoxus/core/modules/database/presentation/test-fixtures");
    return {
      useAssistantPresentation: (
        context: import("@myoxus/graphql").AssistantContext,
      ) => ({
        descriptor: state.descriptor ?? assistantPackagesFixture(context)[0],
        invalidated: false,
        mutate: vi.fn(),
        owner: {
          identity: "actor/workspace",
          server: { id: "home-server", baseUrl: "https://home.example" },
        },
      }),
    };
  },
);
vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalPreferences: () => ({ timezone: "Europe/Berlin" }),
}));
vi.mock("@myoxus/i18n", async () => {
  const { createDatabaseTestI18nModule } =
    await import("@myoxus/core/modules/database/test-i18n-mock");
  return createDatabaseTestI18nModule();
});
const framework = {
  get: (token: unknown) => {
    if (token === GuardService)
      return { can$: () => new LiveData(state.canCreate) };
    throw new Error(`Unexpected service ${String(token)}`);
  },
  getOptional: () => undefined,
} as unknown as FrameworkProvider;
const callbacks = {
  onOpenTasks: vi.fn(),
  onOpenTask: vi.fn(),
  onNewTask: vi.fn(),
};
const result = () => ({
  availability: { status: "available" },
  isLoading: false,
  error: undefined,
  live: true,
  retryLive: vi.fn(),
  mutate: vi.fn(),
  page: {
    totalCount: 14,
    projectCount: 2,
    coverageComplete: true,
    unavailableProjects: [],
    rows: [
      {
        rowId: "canonical-row",
        databaseId: "canonical-project",
        title: "Release coordination",
        projectTitle: "Platform",
        status: { name: "Ready", colorRole: "tag.green" },
        hasDue: true,
        due: { start: "2026-12-15T00:00:00Z", allDay: true, timeZone: "UTC" },
      },
    ],
  },
});
function mount(size: "standard" | "wide" = "standard") {
  return render(
    <FrameworkRoot framework={framework}>
      <MyoxusUIProvider env="test">
        <DashboardTaskSection size={size} {...callbacks} />
      </MyoxusUIProvider>
    </FrameworkRoot>,
  );
}
afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  state.canCreate = true;
  state.descriptor = null;
  state.read.mockReturnValue(result());
});

test("bounded Mine/open preview retains authoritative count and navigates the canonical Task", async () => {
  const view = mount();
  expect(state.read).toHaveBeenLastCalledWith({ timeZone: "Europe/Berlin" }, 4);
  expect(screen.getByText("14 tasks")).not.toBeNull();
  expect(screen.getByText("Platform")).not.toBeNull();
  const row = screen.getByRole("button", { name: /Release coordination/ });
  row.focus();
  await userEvent.keyboard("{Enter}");
  expect(callbacks.onOpenTask).toHaveBeenCalledWith(
    "canonical-project",
    "canonical-row",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open tasks" }));
  expect(callbacks.onOpenTasks).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "New task" }));
  expect(callbacks.onNewTask).toHaveBeenCalledOnce();
  view.unmount();
  mount("wide");
  expect(state.read).toHaveBeenLastCalledWith(expect.anything(), 6);
});

test("loading and denied reads hide cached rows/count and denied creation", () => {
  state.read.mockReturnValue({ ...result(), isLoading: true });
  const view = mount();
  expect(screen.queryByText("14 tasks")).toBeNull();
  expect(screen.queryByText("Release coordination")).toBeNull();
  view.unmount();
  state.read.mockReturnValue({
    ...result(),
    error: new Error("MIX_DATABASE_FORBIDDEN"),
  });
  mount();
  expect(screen.queryByText("14 tasks")).toBeNull();
  expect(screen.queryByText("Release coordination")).toBeNull();
  expect(screen.queryByRole("button", { name: "New task" })).toBeNull();
});
