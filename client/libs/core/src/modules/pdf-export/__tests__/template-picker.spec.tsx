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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const pdfjsMock = vi.hoisted(() => ({
  version: "6.4.299",
  getDocument: vi.fn(() => ({
    destroy: vi.fn(() => Promise.resolve()),
    promise: Promise.resolve({
      getPage: vi.fn(() =>
        Promise.resolve({
          getViewport: vi.fn(() => ({ width: 210, height: 297 })),
          render: vi.fn(() => ({ promise: Promise.resolve() })),
        }),
      ),
    }),
  })),
  GlobalWorkerOptions: { workerSrc: "" },
}));

vi.mock("pdfjs-dist", () => pdfjsMock);

import { PdfTemplatePicker } from "../template-picker";
import type { PdfTemplateOption } from "../types";

const templates: PdfTemplateOption[] = [
  {
    id: "tpl-default",
    slug: "default",
    name: "Default",
    version: "1.0.0",
    schemaVersion: "2.0",
    isDefault: true,
    capabilities: {
      language: { kind: "enum", values: ["en", "de"], default: "en" },
      tocBehavior: { kind: "enum", values: ["off", "auto"] },
      coverPage: { kind: "boolean", default: true },
      confidentialityLabels: {
        kind: "array<string>",
        max_items: 2,
        default: ["Internal"],
      },
    },
  },
  {
    id: "tpl-report",
    slug: "report",
    name: "Report",
    version: "2.1.0",
    schemaVersion: "2.0",
    isDefault: false,
    capabilities: {},
  },
];

describe("PDF template picker", () => {
  beforeEach(() => {
    vi.stubGlobal("__webpack_public_path__", "/");
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      {} as CanvasRenderingContext2D,
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
    vi.restoreAllMocks();
    pdfjsMock.getDocument.mockClear();
  });

  test("renders assigned templates, selected state and selection changes", () => {
    const onSelect = vi.fn();
    render(
      <MyoxusUIProvider>
        <PdfTemplatePicker
          templates={templates}
          selectedTemplateId="tpl-default"
          onSelect={onSelect}
        />
      </MyoxusUIProvider>,
    );

    const defaultTemplate = screen.getByRole("radio", { name: /Default/ });
    expect(defaultTemplate.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(/Workspace default/)).not.toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Report/ }));
    expect(onSelect).toHaveBeenCalledWith(templates[1]);
  });

  test("loads template previews when the visual picker is opened", async () => {
    const loadPreviewPdf = vi.fn(() => Promise.resolve("JVBERi0="));
    render(
      <MyoxusUIProvider>
        <PdfTemplatePicker
          templates={[templates[0]]}
          selectedTemplateId="tpl-default"
          loadPreviewPdf={loadPreviewPdf}
          onSelect={vi.fn()}
        />
      </MyoxusUIProvider>,
    );
    expect(loadPreviewPdf).toHaveBeenCalledWith(templates[0]);

    fireEvent.pointerEnter(
      screen.getByTestId("pdf-template-thumbnail-tpl-default"),
    );

    expect(loadPreviewPdf).toHaveBeenCalledWith(templates[0]);
    await waitFor(() => expect(pdfjsMock.getDocument).toHaveBeenCalledOnce());
  });
});
