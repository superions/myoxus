import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const mutateTemplates = vi.fn();
let templateVersion = "1.0.0";
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({ t: (key: string) => en[key] ?? key, language: "en" }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("./upload-template-dialog", () => ({
  UploadTemplateDialog: ({ onUploaded }: any) => (
    <button onClick={onUploaded}>mock upload dialog</button>
  ),
}));

vi.mock("./template-detail-drawer", () => ({
  TemplateDetailDrawer: ({ template }: any) => (
    <div data-testid="template-detail">
      detail {template.name} {template.version}
    </div>
  ),
}));

vi.mock("../api", () => ({
  usePdfTemplatesQuery: () => ({
    templates: [
      {
        id: "tpl-1",
        slug: "report",
        name: "Report",
        version: templateVersion,
        schemaVersion: "2.0",
        source: "Admin",
        createdAt: "2026-05-01T10:00:00Z",
        createdBy: "admin@example.com",
        deletedAt: null,
        manifest: { capabilities: { cover_page: true } },
      },
      {
        id: "tpl-2",
        slug: "old",
        name: "Old Template",
        version: "0.9.0",
        schemaVersion: "2.0",
        source: "System",
        createdAt: "2026-04-01T10:00:00Z",
        createdBy: null,
        deletedAt: "2026-05-01T10:00:00Z",
        manifest: { capabilities: {} },
      },
    ],
    mutate: mutateTemplates,
  }),
  useDeletePdfTemplateMutation: () => ({ trigger: vi.fn() }),
  usePdfTemplateAssignedWorkspacesQuery: () => ({
    assignments: [],
    isLoading: false,
  }),
}));

import { TemplatesTab } from "./templates-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider env="test">{ui}</MyoxusUIProvider>);
}

describe("TemplatesTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    templateVersion = "1.0.0";
  });
  afterEach(() => cleanup());

  test("an open detail follows the refreshed catalog revision", () => {
    const { rerender } = renderWithFacade(<TemplatesTab />);
    fireEvent.click(screen.getByRole("button", { name: "Report" }));
    expect(screen.getByTestId("template-detail").textContent).toBe(
      "detail Report 1.0.0",
    );

    templateVersion = "1.1.0";
    rerender(
      <MyoxusUIProvider env="test">
        <TemplatesTab />
      </MyoxusUIProvider>,
    );

    expect(screen.getByTestId("template-detail").textContent).toBe(
      "detail Report 1.1.0",
    );
    expect(screen.queryByText("detail Report 1.0.0")).toBeNull();
  });

  test("renders active templates and filters by search text", () => {
    renderWithFacade(<TemplatesTab />);

    expect(screen.getByText("Report")).toBeTruthy();
    expect(screen.queryByText("Old Template")).toBeNull();

    fireEvent.change(
      screen.getByPlaceholderText(en["admin.pdf-export.filter.search"]),
      {
        target: { value: "missing" },
      },
    );
    expect(screen.queryByText("Report")).toBeNull();
    expect(
      screen.getByText(en["admin.pdf-export.list.empty-filtered"]),
    ).toBeTruthy();
  });

  test("filters by source and deleted status", async () => {
    const user = userEvent.setup();
    renderWithFacade(<TemplatesTab />);

    await user.click(
      screen.getByRole("combobox", {
        name: en["admin.pdf-export.filter.status"],
      }),
    );
    await user.click(
      await screen.findByRole("option", {
        name: en["admin.pdf-export.filter.status.all"],
      }),
    );
    const source = screen.getByRole("combobox", {
      name: en["admin.pdf-export.filter.source"],
    });
    await user.click(source);
    await user.click(
      await screen.findByRole("option", {
        name: en["admin.pdf-export.source.system"],
      }),
    );
    expect(screen.queryByText("Report")).toBeNull();
    expect(screen.getByText("Old Template").textContent).toBe("Old Template");

    const status = screen.getByRole("combobox", {
      name: en["admin.pdf-export.filter.status"],
    });
    await user.click(status);
    await user.click(
      await screen.findByRole("option", {
        name: en["admin.pdf-export.status.deleted"],
      }),
    );
    expect(screen.getByText("Old Template").textContent).toBe("Old Template");
    expect(screen.queryByText("Report")).toBeNull();
  });

  test("resets active filters", () => {
    renderWithFacade(<TemplatesTab />);

    fireEvent.change(
      screen.getByPlaceholderText(en["admin.pdf-export.filter.search"]),
      {
        target: { value: "missing" },
      },
    );
    expect(
      screen.getByText(en["admin.pdf-export.list.empty-filtered"]),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: en["admin.pdf-export.filter.reset"] }),
    );
    expect(screen.getByText("Report")).toBeTruthy();
  });

  test("refreshes the list after a successful upload", () => {
    renderWithFacade(<TemplatesTab />);

    fireEvent.click(screen.getByText(en["admin.pdf-export.upload.button"]));
    fireEvent.click(screen.getByText("mock upload dialog"));

    expect(mutateTemplates).toHaveBeenCalled();
  });
});
