import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const updateTemplate = vi.fn().mockResolvedValue({});
const getPreviewPage = vi.hoisted(() =>
  vi.fn(() =>
    Promise.resolve({
      getViewport: vi.fn(() => ({ width: 320, height: 453 })),
      render: vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() })),
      cleanup: vi.fn(),
    }),
  ),
);
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
let previewResponse: { pdfBase64: string | null; error: Error | null } = {
  pdfBase64: "JVBERi0xLjQ=",
  error: null,
};

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
    language: "en",
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("pdfjs-dist", () => ({
  version: "6.4.299",
  GlobalWorkerOptions: {
    workerSrc: "",
  },
  getDocument: vi.fn(() => ({
    destroy: vi.fn().mockResolvedValue(undefined),
    promise: Promise.resolve({
      numPages: 2,
      getPage: getPreviewPage,
    }),
  })),
}));

vi.mock("../api", () => ({
  usePdfTemplateAssignedWorkspacesQuery: () => ({
    assignments: [
      {
        workspaceId: "ws-1",
        isDefault: true,
        assignedAt: "2026-05-01T10:00:00Z",
      },
    ],
    isLoading: false,
  }),
  usePdfTemplateFilesQuery: () => ({
    files: [
      {
        filePath: "preamble.typ",
        blobKey: "blob-a",
        contentHash: "abcdef1234567890",
      },
    ],
    isLoading: false,
  }),
  usePdfTemplatePreviewPdfQuery: () => previewResponse,
  useUpdatePdfTemplateMetadataMutation: () => ({ trigger: updateTemplate }),
  useUploadPdfTemplateMutation: () => ({ trigger: vi.fn() }),
  useReplacePdfTemplateBundleMutation: () => ({ trigger: vi.fn() }),
}));

import { TemplateDetailDrawer } from "./template-detail-drawer";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

const template: any = {
  id: "tpl-1",
  slug: "report",
  name: "Report",
  description: "Board report",
  version: "1.2.3",
  schemaVersion: "2.0",
  source: "admin",
  isDeleted: false,
  capabilities: { cover_page: true, language: "en" },
  provenance: {
    licenseSpdx: "AGPL-3.0-or-later",
    copyrightNotice: "Copyright 2026 Myoxus contributors",
    sourceUrl: "https://example.test/template",
    sourceRevision: "1.0.0",
    notice: null,
  },
  manifest: { id: "report", entry: "preamble.typ" },
};

describe("TemplateDetailDrawer", () => {
  beforeEach(() => {
    vi.stubGlobal("__webpack_public_path__", "/admin/");
    vi.clearAllMocks();
    previewResponse = { pdfBase64: "JVBERi0xLjQ=", error: null };
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    vi.restoreAllMocks();
  });

  test("renders the server-side preview PDF through PDF.js", async () => {
    renderWithFacade(
      <TemplateDetailDrawer
        template={template}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: en["admin.pdf-export.detail.tab.preview"],
      }),
    );

    const canvas = await waitFor(() => {
      const candidate = document.body.querySelector("canvas");
      if (!candidate) {
        throw new Error("Preview canvas not found");
      }
      return candidate;
    });
    await waitFor(() => expect(canvas.dataset.renderState).toBe("ready"));
    const previous = screen.getByRole("button", {
      name: en["admin.common.previous"],
    });
    const next = screen.getByRole("button", { name: en["admin.common.next"] });
    expect(previous.hasAttribute("disabled")).toBe(true);
    fireEvent.click(next);
    await waitFor(() => expect(getPreviewPage).toHaveBeenLastCalledWith(2));
    await waitFor(() => expect(canvas.dataset.renderState).toBe("ready"));
    expect(next.hasAttribute("disabled")).toBe(true);
    fireEvent.click(previous);
    await waitFor(() => expect(getPreviewPage).toHaveBeenLastCalledWith(1));
    const pdfjs = await import("pdfjs-dist");
    expect(pdfjs.getDocument).toHaveBeenCalledTimes(1);
  });

  test("renders server preview errors as alert", () => {
    previewResponse = {
      pdfBase64: null,
      error: new Error("template preview render failed"),
    };
    renderWithFacade(
      <TemplateDetailDrawer
        template={template}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: en["admin.pdf-export.detail.tab.preview"],
      }),
    );

    expect(screen.getByRole("alert").textContent).toContain(
      "template preview render failed",
    );
  });

  test("saves edited admin template metadata", async () => {
    const onChanged = vi.fn();
    renderWithFacade(
      <TemplateDetailDrawer
        template={template}
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );
    fireEvent.click(
      screen.getByRole("tab", {
        name: en["admin.pdf-export.detail.tab.edit"],
      }),
    );

    fireEvent.change(
      screen.getByLabelText(en["admin.pdf-export.detail.name"]),
      {
        target: { value: "Updated Report" },
      },
    );
    fireEvent.click(screen.getByText(en["admin.common.save"]));

    await waitFor(() =>
      expect(updateTemplate).toHaveBeenCalledWith({
        id: "tpl-1",
        name: "Updated Report",
        description: undefined,
      }),
    );
    expect(onChanged).toHaveBeenCalled();
  });

  test("hides edit fields for system templates", () => {
    renderWithFacade(
      <TemplateDetailDrawer
        template={{ ...template, source: "system" }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("tab", {
        name: en["admin.pdf-export.detail.tab.edit"],
      }),
    ).toBeNull();
  });

  test("hides edit fields for archived templates", () => {
    renderWithFacade(
      <TemplateDetailDrawer
        template={{ ...template, isDeleted: true }}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("tab", {
        name: en["admin.pdf-export.detail.tab.edit"],
      }),
    ).toBeNull();
  });
});
