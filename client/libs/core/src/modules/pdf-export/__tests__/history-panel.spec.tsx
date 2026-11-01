/**
 * @vitest-environment happy-dom
 */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  download: vi.fn(),
  openDialog: vi.fn(),
  notifyWarning: vi.fn(),
  templates: [{ id: "tpl-default" }] as Array<{ id: string }>,
  workspaceDialogService: {
    open: vi.fn(),
    fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
  },
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => mocks.workspaceDialogService,
}));

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalFormatters: () => ({
    formatDateTime: (value: string) => value,
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/ui-facade")>();
  return {
    ...actual,
    notify: {
      error: vi.fn(),
      success: vi.fn(),
      warning: mocks.notifyWarning,
    },
  };
});

vi.mock("@virgultum/editor/widgets/linked-doc", () => ({
  download: (...args: unknown[]) => mocks.download(...args),
}));

vi.mock("../export-dialog", () => ({
  loadPdfExportDialogBootstrap: async () => ({
    availablePdfTemplates: mocks.templates,
  }),
  openPdfExportDialog: (...args: unknown[]) => mocks.openDialog(...args),
  requireAssignedPdfTemplate: (bootstrap: {
    availablePdfTemplates: unknown[];
  }) => {
    if (bootstrap.availablePdfTemplates.length === 0) {
      throw Object.assign(new Error("workspace has no assigned PDF template"), {
        errorClass: "WorkspaceConfigurationRequired",
      });
    }
  },
}));

import { PdfExportHistoryPanel } from "../history-panel";
import { dispatchPdfExportCompleted } from "../events";

const historyEntry = {
  id: "job-1",
  workspaceId: "ws-1",
  docId: "doc-1",
  templateId: "tpl-report",
  status: "done",
  downloadUrl: "/api/pdf-export/job-1/download",
  errorClass: null,
  errorDetail: null,
  renderInputs: {
    locale: "de",
    paper_size: "A4",
    orientation: "landscape",
    image_quality: "high",
    cover_page: true,
    toc_behavior: "auto",
  },
  pageCount: 7,
  createdAt: "2026-05-01T10:00:00Z",
  startedAt: "2026-05-01T10:00:01Z",
  finishedAt: "2026-05-01T10:00:03Z",
  expiresAt: "2026-05-02T10:00:03Z",
  unmappedFontFamilies: [],
};

function renderPanel(gql = vi.fn(), entries = [historyEntry]) {
  gql.mockResolvedValue({ documentPdfExportHistory: entries });
  render(
    <MyoxusUIProvider>
      <PdfExportHistoryPanel
        workspaceId="ws-1"
        docId="doc-1"
        docTitle="Board/Report"
        graphqlService={{ gql } as never}
      />
    </MyoxusUIProvider>,
  );
  return gql;
}

describe("PDF export history panel", () => {
  beforeEach(() => {
    mocks.templates = [{ id: "tpl-default" }];
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test("renders history data with real facade list primitives", async () => {
    const gql = renderPanel();

    expect((await screen.findByText("tpl-repo...")).textContent).toBe(
      "tpl-repo...",
    );
    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent ===
          "com.myoxus.sidebar.pdf-exports.meta.locale: de",
      ),
    ).toHaveProperty(
      "textContent",
      "com.myoxus.sidebar.pdf-exports.meta.locale: de",
    );
    expect(
      screen.getByText("com.myoxus.sidebar.pdf-exports.status.done"),
    ).toHaveProperty(
      "textContent",
      "com.myoxus.sidebar.pdf-exports.status.done",
    );
    expect(
      screen.getByText(
        (_content, element) =>
          element?.textContent ===
          "com.myoxus.sidebar.pdf-exports.meta.pages: 7",
      ),
    ).toHaveProperty(
      "textContent",
      "com.myoxus.sidebar.pdf-exports.meta.pages: 7",
    );
    expect(gql).toHaveBeenCalledWith({
      query: expect.objectContaining({ op: "documentPdfExportHistory" }),
      variables: { workspaceId: "ws-1", docId: "doc-1", limit: 20 },
    });
  });

  test("passes history values into the registered export dialog", async () => {
    mocks.openDialog.mockResolvedValue(null);
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /action\.reexport/ }),
    );

    await waitFor(() =>
      expect(mocks.openDialog).toHaveBeenCalledWith(
        mocks.workspaceDialogService,
        expect.objectContaining({
          workspaceId: "ws-1",
          docId: "doc-1",
          initialTemplateId: "tpl-report",
          initialFormValue: expect.objectContaining({
            locale: "de",
            paperSize: "A4",
            orientation: "landscape",
            imageQuality: "high",
            coverPage: true,
            tocBehavior: "auto",
          }),
        }),
      ),
    );
  });

  test("reports missing workspace configuration as a notification, never a modal", async () => {
    mocks.templates = [];
    const gql = vi.fn();
    renderPanel(gql, []);

    fireEvent.click(
      await screen.findByRole("button", { name: /button\.start/ }),
    );

    await waitFor(() => expect(mocks.notifyWarning).toHaveBeenCalledOnce());
    expect(mocks.openDialog).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("re-download reuses the completed artifact", async () => {
    const blob = new Blob(["pdf"], { type: "application/pdf" });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () => Promise.resolve(blob),
      }),
    );
    renderPanel();

    fireEvent.click(
      await screen.findByRole("button", { name: /action\.redownload/ }),
    );

    await waitFor(() =>
      expect(mocks.download).toHaveBeenCalledWith(
        blob,
        expect.stringMatching(/^Board-Report-.*\.pdf$/),
      ),
    );
    expect(mocks.openDialog).not.toHaveBeenCalled();
  });

  test("keeps the latest completion read when an older request rejects", async () => {
    const old = Promise.withResolvers<unknown>();
    const gql = vi
      .fn()
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValue({ documentPdfExportHistory: [historyEntry] });
    render(
      <MyoxusUIProvider>
        <PdfExportHistoryPanel
          workspaceId="ws-1"
          docId="doc-1"
          docTitle="Report"
          graphqlService={{ gql } as never}
        />
      </MyoxusUIProvider>,
    );
    act(() =>
      dispatchPdfExportCompleted({
        workspaceId: "ws-1",
        docId: "another-doc",
        jobId: "other",
        downloadUrl: "/pdf",
      }),
    );
    expect(gql).toHaveBeenCalledTimes(1);
    act(() =>
      dispatchPdfExportCompleted({
        workspaceId: "ws-1",
        docId: "doc-1",
        jobId: "new",
        downloadUrl: "/pdf",
      }),
    );
    await screen.findByText("tpl-repo...");
    await act(async () => old.reject(new Error("Obsolete failure")));
    expect(screen.queryByText("Obsolete failure")).toBeNull();
    expect(screen.getByText("tpl-repo...")).not.toBeNull();
    expect(
      screen.getByTestId("pdf-export-history-refresh").hasAttribute("disabled"),
    ).toBe(false);
  });

  test.each(["document", "workspace", "service"])(
    "fences pending history after a %s switch",
    async (changed) => {
      const old = Promise.withResolvers<unknown>();
      const current = Promise.withResolvers<unknown>();
      const gql = vi
        .fn()
        .mockResolvedValueOnce({ documentPdfExportHistory: [historyEntry] })
        .mockImplementationOnce(() => old.promise)
        .mockImplementation(() => current.promise);
      const service = { gql } as never;
      const replacement = { gql: vi.fn(() => current.promise) } as never;
      const element = (next: boolean) => (
        <MyoxusUIProvider>
          <PdfExportHistoryPanel
            workspaceId={next && changed === "workspace" ? "ws-2" : "ws-1"}
            docId={next && changed === "document" ? "doc-2" : "doc-1"}
            docTitle="Report"
            graphqlService={
              next && changed === "service" ? replacement : service
            }
          />
        </MyoxusUIProvider>
      );
      const view = render(element(false));
      await screen.findByText("tpl-repo...");
      fireEvent.click(screen.getByTestId("pdf-export-history-refresh"));
      view.rerender(element(true));
      expect(screen.queryByText("tpl-repo...")).toBeNull();
      expect(screen.queryByTestId("pdf-export-history-empty")).toBeNull();
      expect(
        screen
          .getByTestId("pdf-export-history-panel")
          .hasAttribute("data-empty"),
      ).toBe(false);
      await act(async () => current.resolve({ documentPdfExportHistory: [] }));
      await screen.findByTestId("pdf-export-history-empty");
      await act(async () =>
        old.resolve({ documentPdfExportHistory: [historyEntry] }),
      );
      expect(screen.queryByText("tpl-repo...")).toBeNull();
      expect(
        screen
          .getByTestId("pdf-export-history-panel")
          .getAttribute("data-empty"),
      ).toBe("true");
    },
  );
});
