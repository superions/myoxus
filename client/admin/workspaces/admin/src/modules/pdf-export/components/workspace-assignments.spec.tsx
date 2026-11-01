/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const assignTrigger = vi.fn().mockResolvedValue({});
const unassignTrigger = vi.fn().mockResolvedValue({});
const setDefaultTrigger = vi.fn().mockResolvedValue({});
const mutateAssignments = vi.fn();
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
let assignmentRows = [
  { workspaceId: "ws-1", templateId: "tpl-1", isDefault: true },
  { workspaceId: "ws-1", templateId: "tpl-2", isDefault: false },
];

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => en[key] ?? key, language: "en" }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("../../../use-query", () => ({
  useQuery: () => ({
    data: {
      admin: {
        adminWorkspaces: [
          { id: "ws-1", name: "Workspace One" },
          { id: "ws-2", name: "Workspace Two" },
        ],
      },
    },
  }),
}));

vi.mock("../api", () => ({
  usePdfTemplatesQuery: () => ({
    templates: [
      {
        id: "tpl-1",
        slug: "report",
        name: "Report",
        version: "1.0.0",
        schemaVersion: "2.0",
        source: "Admin",
        createdAt: "2026-05-01T10:00:00Z",
        createdBy: null,
        deletedAt: null,
        manifest: { capabilities: {} },
      },
      {
        id: "tpl-2",
        slug: "letter",
        name: "Letter",
        version: "1.0.0",
        schemaVersion: "2.0",
        source: "Admin",
        createdAt: "2026-05-01T10:00:00Z",
        createdBy: null,
        deletedAt: null,
        manifest: { capabilities: {} },
      },
    ],
  }),
  usePdfWorkspaceAssignmentsQuery: () => ({
    assignments: assignmentRows,
    mutate: mutateAssignments,
  }),
  useAssignPdfTemplateToWorkspaceMutation: () => ({ trigger: assignTrigger }),
  useUnassignPdfTemplateFromWorkspaceMutation: () => ({
    trigger: unassignTrigger,
  }),
  useSetWorkspaceDefaultPdfTemplateMutation: () => ({
    trigger: setDefaultTrigger,
  }),
}));

import { WorkspacesTab } from "./workspaces-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function chooseWorkspace() {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name: "Workspace One" }));
}

describe("WorkspacesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    assignmentRows = [
      { workspaceId: "ws-1", templateId: "tpl-1", isDefault: true },
      { workspaceId: "ws-1", templateId: "tpl-2", isDefault: false },
    ];
  });
  afterEach(() => cleanup());

  test("toggles template assignment and bulk-assigns selected rows", async () => {
    renderWithFacade(<WorkspacesTab />);
    await chooseWorkspace();

    const toggles = screen.getAllByLabelText(
      en["admin.pdf-export.assignment.toggle-aria"],
    );
    fireEvent.click(toggles[1]);
    await waitFor(() =>
      expect(unassignTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-2",
      }),
    );

    const selects = screen.getAllByLabelText(
      en["admin.pdf-export.assignment.select-aria"],
    );
    fireEvent.click(selects[1]);
    fireEvent.click(
      screen.getByText(en["admin.pdf-export.assignment.bulk-assign"]),
    );
    await waitFor(() =>
      expect(assignTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-2",
      }),
    );
  });

  test("confirms default template switches", async () => {
    renderWithFacade(<WorkspacesTab />);
    await chooseWorkspace();

    fireEvent.click(
      screen.getAllByLabelText(
        en["admin.pdf-export.assignment.default-aria"],
      )[1],
    );
    expect(screen.getByRole("dialog").textContent).toContain(
      en["admin.pdf-export.assignment.default-confirm"],
    );
    expect(setDefaultTrigger).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: en["admin.common.confirm"],
      }),
    );

    await waitFor(() =>
      expect(setDefaultTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-2",
      }),
    );
  });

  test("assigns an unassigned template from the toggle path", async () => {
    assignmentRows = [
      { workspaceId: "ws-1", templateId: "tpl-1", isDefault: true },
    ];
    renderWithFacade(<WorkspacesTab />);
    await chooseWorkspace();

    const toggles = screen.getAllByLabelText(
      en["admin.pdf-export.assignment.toggle-aria"],
    );
    fireEvent.click(toggles[1]);

    await waitFor(() =>
      expect(assignTrigger).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        templateId: "tpl-2",
      }),
    );
  });

  test("filters assignment rows by search text", async () => {
    renderWithFacade(<WorkspacesTab />);
    await chooseWorkspace();

    fireEvent.change(
      screen.getByPlaceholderText(en["admin.pdf-export.assignment.search"]),
      {
        target: { value: "letter" },
      },
    );

    expect(screen.queryByText("Report")).toBeNull();
    expect(screen.getByText("Formal letter")).toBeTruthy();
  });

  test("workspace changes isolate local search and bulk-selection state", async () => {
    const user = userEvent.setup();
    renderWithFacade(<WorkspacesTab />);
    await chooseWorkspace();
    await user.click(
      screen.getAllByLabelText(
        en["admin.pdf-export.assignment.select-aria"],
      )[0],
    );
    fireEvent.change(
      screen.getByPlaceholderText(en["admin.pdf-export.assignment.search"]),
      { target: { value: "report" } },
    );
    await user.click(screen.getByRole("combobox"));
    await user.clear(screen.getByRole("combobox"));
    await user.type(screen.getByRole("combobox"), "Workspace Two");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe(
      "Workspace Two",
    );
    expect(
      (
        screen.getByPlaceholderText(
          en["admin.pdf-export.assignment.search"],
        ) as HTMLInputElement
      ).value,
    ).toBe("");
    expect(
      screen
        .getAllByLabelText(en["admin.pdf-export.assignment.select-aria"])
        .every((input) => !(input as HTMLInputElement).checked),
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: en["admin.pdf-export.assignment.bulk-assign"],
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(assignTrigger).not.toHaveBeenCalled();
  });

  test("does not allow an unassigned template to become default", async () => {
    assignmentRows = [
      { workspaceId: "ws-1", templateId: "tpl-1", isDefault: true },
    ];
    renderWithFacade(<WorkspacesTab />);
    await chooseWorkspace();

    expect(
      (
        screen.getAllByLabelText(
          en["admin.pdf-export.assignment.default-aria"],
        )[1] as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
