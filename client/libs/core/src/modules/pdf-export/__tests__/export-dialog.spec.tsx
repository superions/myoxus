/**
 * @vitest-environment happy-dom
 */
import { DocumentMetadataValidationSeverityType } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef, useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gql: vi.fn(),
  runServerPdfExport: vi.fn(),
}));

vi.mock("@myoxus/core/modules/server", () => ({
  EventSourceService: class EventSourceService {},
  FetchService: class FetchService {},
  GraphQLService: class GraphQLService {},
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => ({ gql: mocks.gql }),
}));

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalFormatters: () => ({
    formatDateTime: (value: string) => value,
  }),
}));

vi.mock("../template-preview-thumbnail", () => ({
  PdfTemplatePreviewThumbnail: ({ templateName }: { templateName: string }) => (
    <span aria-hidden="true">{templateName} preview</span>
  ),
}));

vi.mock("../run-server-export", () => ({
  runServerPdfExport: (...args: unknown[]) => mocks.runServerPdfExport(...args),
}));

import { openPdfExportDialog, PdfExportDialog } from "../export-dialog";
import type { PdfExportDialogBootstrap } from "../types";
import { createPdfExportBootstrap } from "./fixtures";

function renderDialog(
  bootstrap: PdfExportDialogBootstrap = createPdfExportBootstrap(),
  initialTemplateId = "tpl-report",
) {
  mocks.gql.mockResolvedValue({ pdfTemplatePreviewPdf: null });
  return render(
    <MyoxusUIProvider>
      <PdfExportDialog
        close={vi.fn()}
        workspaceId="ws-1"
        docId="doc-1"
        docTitle="Doc"
        bootstrap={bootstrap}
        initialTemplateId={initialTemplateId}
        initialFormValue={{ locale: "de", tocBehavior: "auto" }}
      />
    </MyoxusUIProvider>,
  );
}

describe("PDF export dialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("uses native facade radio cards and form controls for the workflow", async () => {
    renderDialog();

    const report = await screen.findByRole("radio", { name: /Report/ });
    expect(report.getAttribute("aria-checked")).toBe("true");

    const user = userEvent.setup();
    screen.getByRole("button", { name: /Export inputs/ }).focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox", { name: "Locale" })).toHaveProperty(
      "value",
      "de",
    );
    expect(
      screen.getByRole("combobox", { name: "Table of contents" }),
    ).toHaveProperty("value", "Automatic");
    mocks.runServerPdfExport.mockResolvedValueOnce({
      unmappedFontFamilies: [],
    });
    await user.click(screen.getByRole("button", { name: "Start export" }));
    expect(mocks.runServerPdfExport).toHaveBeenCalledWith(
      "ws-1",
      "doc-1",
      "Doc",
      expect.anything(),
      expect.objectContaining({
        templateId: "tpl-report",
        locale: "de",
        tocBehavior: "auto",
        complianceProfile: "pdfa-2u",
      }),
    );
  });

  test("preserves explicit Tagged PDF selection through failure and retry", async () => {
    renderDialog();
    const user = userEvent.setup();
    await user.click(
      await screen.findByRole("button", { name: /Export inputs/ }),
    );
    const profile = screen.getByRole("combobox", { name: "PDF profile" });
    expect(profile).toHaveProperty("value", "PDF/A-2u");
    profile.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(profile).toHaveProperty("value", "PDF 1.7 (Tagged)");
    await user.click(screen.getByRole("button", { name: "Template" }));
    await user.click(screen.getByRole("radio", { name: /Default/ }));
    await user.click(screen.getByRole("button", { name: /Export inputs/ }));
    expect(
      screen.getByRole("combobox", { name: "PDF profile" }),
    ).toHaveProperty("value", "PDF 1.7 (Tagged)");
    mocks.runServerPdfExport.mockRejectedValueOnce(
      Object.assign(new Error("validation failed"), {
        errorClass: "PdfaValidationFailed",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Start export" }));
    await screen.findByTestId("pdf-export-error");
    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(
      screen.getByRole("combobox", { name: "PDF profile" }),
    ).toHaveProperty("value", "PDF 1.7 (Tagged)");
    mocks.runServerPdfExport.mockResolvedValueOnce({
      unmappedFontFamilies: [],
      saved: true,
    });
    await user.click(screen.getByRole("button", { name: "Start export" }));
    expect(mocks.runServerPdfExport).toHaveBeenCalledTimes(2);
    for (const call of mocks.runServerPdfExport.mock.calls)
      expect(call[4].complianceProfile).toBe("standard");
  });

  test("preserves and submits the selected orientation across template changes", async () => {
    renderDialog();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: /Export inputs/ }),
    );
    const orientation = screen.getByRole("combobox", { name: "Orientation" });
    expect(orientation).toHaveProperty("value", "Portrait");
    orientation.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(orientation).toHaveProperty("value", "Landscape");

    const paperSize = screen.getByRole("combobox", { name: "Paper size" });
    paperSize.focus();
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
    expect(paperSize).toHaveProperty("value", "A3");
    await user.click(screen.getByRole("button", { name: "Template" }));
    await user.click(screen.getByRole("radio", { name: /Default/ }));
    await user.click(screen.getByRole("button", { name: /Export inputs/ }));

    expect(
      screen.getByRole("combobox", { name: "Orientation" }),
    ).toHaveProperty("value", "Landscape");
    expect(screen.getByRole("combobox", { name: "Paper size" })).toHaveProperty(
      "value",
      "A3",
    );
    mocks.runServerPdfExport.mockResolvedValueOnce({
      unmappedFontFamilies: [],
    });
    await user.click(screen.getByRole("button", { name: "Start export" }));
    expect(mocks.runServerPdfExport).toHaveBeenCalledWith(
      "ws-1",
      "doc-1",
      "Doc",
      expect.anything(),
      expect.objectContaining({
        templateId: "tpl-default",
        orientation: "landscape",
        paperSize: "A3",
      }),
    );
  });

  test("keeps a historical slug selection within the assigned template inventory", async () => {
    renderDialog(createPdfExportBootstrap(), "report");
    expect(
      (await screen.findByRole("radio", { name: /Report/ })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  test.each(["escape", "cancel"])(
    "returns focus before removing the service dialog on %s",
    async (action) => {
      const user = userEvent.setup();
      function ServiceOwner() {
        const trigger = useRef<HTMLButtonElement>(null);
        const [visible, setVisible] = useState(true);
        return (
          <MyoxusUIProvider>
            <button ref={trigger}>Document menu</button>
            {visible ? (
              <PdfExportDialog
                close={() => setVisible(false)}
                returnFocusRef={trigger}
                workspaceId="ws-1"
                docId="doc-1"
                docTitle="Doc"
                bootstrap={createPdfExportBootstrap()}
              />
            ) : null}
          </MyoxusUIProvider>
        );
      }
      render(<ServiceOwner />);
      await screen.findByRole("dialog");
      if (action === "escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: "Cancel" }));
      await waitFor(() => {
        expect(screen.queryByRole("dialog")).toBeNull();
        expect(document.activeElement).toBe(
          screen.getByRole("button", { name: "Document menu" }),
        );
      });
    },
  );

  test("keeps navigation editable without treating the progress step as an export action", async () => {
    renderDialog();
    fireEvent.click(
      await screen.findByRole("button", { name: /Export inputs/ }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Locale" }));
    fireEvent.click(await screen.findByRole("option", { name: "en" }));
    fireEvent.click(screen.getByRole("button", { name: /Template/ }));
    expect(screen.getByRole("radio", { name: /Report/ })).toBeInstanceOf(
      HTMLElement,
    );
    fireEvent.click(screen.getByRole("button", { name: /Export inputs/ }));
    expect(screen.getByRole("combobox", { name: "Locale" })).toHaveProperty(
      "value",
      "en",
    );
    fireEvent.click(screen.getByRole("button", { name: /Ready/ }));
    expect(screen.getByRole("button", { name: "Start export" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(mocks.runServerPdfExport).not.toHaveBeenCalled();
  });

  test("shows server input validation with a return path instead of generic support recovery", async () => {
    mocks.runServerPdfExport.mockRejectedValueOnce(
      Object.assign(new Error("invalid export inputs"), {
        extensions: {
          class: "CapabilityViolation",
          violationsJson: "report_date: invalid date",
        },
      }),
    );
    renderDialog();
    fireEvent.click(await screen.findByRole("button", { name: /continue/i }));
    fireEvent.click(screen.getByRole("button", { name: "Start export" }));
    expect(
      (await screen.findByTestId("pdf-export-error")).textContent,
    ).toContain("Review export inputs");
    fireEvent.click(screen.getByRole("button", { name: "Technical details" }));
    expect(screen.getByTestId("pdf-export-error").textContent).toContain(
      "report_date: invalid date",
    );
    expect(screen.getByTestId("pdf-export-error").textContent).not.toContain(
      "send them to support",
    );
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(screen.getByRole("button", { name: "Start export" })).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.queryByTestId("pdf-export-error")).toBeNull();
  });

  test("skips template selection when only the workspace default is assigned", async () => {
    const bootstrap = createPdfExportBootstrap();
    bootstrap.availablePdfTemplates = [bootstrap.availablePdfTemplates[0]];
    renderDialog(bootstrap);

    expect(
      (await screen.findByRole("combobox", { name: "PDF profile" })).tagName,
    ).toBe("INPUT");
    expect(screen.queryByRole("radio")).toBeNull();
  });

  test("rejects missing workspace configuration before opening a modal", () => {
    const bootstrap = createPdfExportBootstrap();
    bootstrap.availablePdfTemplates = [];
    const open = vi.fn();

    expect(() =>
      openPdfExportDialog({ open } as never, {
        workspaceId: "ws-1",
        docId: "doc-1",
        docTitle: "Doc",
        bootstrap,
      }),
    ).toThrowError("workspace has no assigned PDF template");
    expect(open).not.toHaveBeenCalled();
  });

  test("keeps metadata policy failures in the real notice and disables export", async () => {
    const bootstrap = createPdfExportBootstrap();
    bootstrap.documentMetadataValidation = {
      valid: false,
      missingRequiredMetadataFields: ["classification"],
      blockedActions: ["export_pdf"],
      errors: [
        {
          code: "DOCUMENT_EXPORT_BLOCKED",
          key: "classification",
          message: "Classification is required for export",
          severity: DocumentMetadataValidationSeverityType.error,
          blockedActions: ["export_pdf"],
          details: {},
        },
      ],
      warnings: [],
    };
    renderDialog(bootstrap);
    fireEvent.click(await screen.findByRole("button", { name: /continue/i }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Classification is required for export",
    );
    expect(screen.getByRole("button", { name: "Start export" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(mocks.runServerPdfExport).not.toHaveBeenCalled();
  });

  test("registers the workflow in WorkspaceDialogService", async () => {
    const bootstrap = createPdfExportBootstrap();
    const result = { unmappedFontFamilies: [] };
    const open = vi.fn((_type, _props, callback) => {
      callback(result);
      return "pdf-export-dialog";
    });

    await expect(
      openPdfExportDialog({ open } as never, {
        workspaceId: "ws-1",
        docId: "doc-1",
        docTitle: "Doc",
        bootstrap,
      }),
    ).resolves.toEqual(result);
    expect(open).toHaveBeenCalledWith(
      "pdf-export",
      expect.objectContaining({ workspaceId: "ws-1", bootstrap }),
      expect.any(Function),
    );
  });
});
