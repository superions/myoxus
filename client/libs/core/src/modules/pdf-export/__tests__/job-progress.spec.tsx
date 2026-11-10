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
import { afterEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gql: vi.fn(),
  runServerPdfExport: vi.fn(),
  hydrateMetadata: vi.fn().mockResolvedValue({}),
  invalidateIndex: vi.fn(),
  markStale: vi.fn(),
}));

vi.mock("@myoxus/core/modules/server", () => ({
  EventSourceService: class EventSourceService {},
  FetchService: class FetchService {},
  GraphQLService: class GraphQLService {},
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => ({
    gql: mocks.gql,
    hydrateMetadata: mocks.hydrateMetadata,
    invalidateIndex: mocks.invalidateIndex,
    markStale: mocks.markStale,
  }),
}));

vi.mock(
  "@myoxus/core/modules/document-metadata/services/document-metadata-cache",
  () => ({
    DocumentMetadataCacheService: class DocumentMetadataCacheService {},
  }),
);

vi.mock("@myoxus/core/components/hooks/myoxus/use-user-preferences", () => ({
  useRegionalFormatters: () => ({
    formatDateTime: (value: string) => value,
  }),
}));

vi.mock("../run-server-export", () => ({
  runServerPdfExport: (...args: unknown[]) => mocks.runServerPdfExport(...args),
}));

import { PdfExportDialog } from "../export-dialog";
import { createPdfExportBootstrap } from "./fixtures";

function renderDialog() {
  const bootstrap = createPdfExportBootstrap();
  bootstrap.availablePdfTemplates = [bootstrap.availablePdfTemplates[0]];
  mocks.gql.mockImplementation(({ query }: { query: { op?: string } }) =>
    Promise.resolve(
      query.op === "cancelPdfExportJob"
        ? { cancelPdfExportJob: true }
        : { pdfTemplatePreviewPdf: null },
    ),
  );
  render(
    <MyoxusUIProvider>
      <PdfExportDialog
        close={vi.fn()}
        workspaceId="ws-1"
        docId="doc-1"
        docTitle="Doc"
        bootstrap={bootstrap}
      />
    </MyoxusUIProvider>,
  );
}

describe("PDF export job progress", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  test("allows cancellation only while the server job is queued", async () => {
    mocks.runServerPdfExport.mockImplementation(
      (_workspaceId, _docId, _docTitle, _graphqlService, options) => {
        options.onProgress({
          jobId: "job-queued",
          status: "queued",
          phase: "queued",
          downloadUrl: null,
          errorClass: null,
          errorDetail: null,
          pageCount: null,
          unmappedFontFamilies: [],
        });
        return new Promise(() => {});
      },
    );
    renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: "Start export" }),
    );
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    expect(cancel).toHaveProperty("disabled", false);
    fireEvent.click(cancel);

    await waitFor(() =>
      expect(mocks.gql).toHaveBeenCalledWith({
        query: expect.objectContaining({ op: "cancelPdfExportJob" }),
        variables: { jobId: "job-queued" },
      }),
    );
  });

  test("renders structured server failures through the facade notice", async () => {
    mocks.runServerPdfExport.mockRejectedValue(
      Object.assign(new Error("renderer timeout"), {
        jobId: "job-failed",
        errorClass: "Timeout",
        errorDetail: "render exceeded timeout",
      }),
    );
    renderDialog();

    fireEvent.click(
      await screen.findByRole("button", { name: "Start export" }),
    );

    expect((await screen.findByTestId("pdf-export-error")).tagName).toBe(
      "SECTION",
    );
    expect(screen.getByText(/Render timed out/).textContent).toContain(
      "Render timed out",
    );
    const details = screen.getByRole("button", { name: "Technical details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/job_id: job-failed/).textContent).toContain(
      "job_id: job-failed",
    );
  });
});
