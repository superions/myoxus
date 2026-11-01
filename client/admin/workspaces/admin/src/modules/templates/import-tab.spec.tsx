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

const mockRevalidate = vi.fn().mockResolvedValue(undefined);
const mockImportTemplateBundle = vi.fn();
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

vi.mock("./api", () => ({
  importTemplateBundle: (...args: any[]) => mockImportTemplateBundle(...args),
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: mockRevalidate,
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

import { ImportTab } from "./import-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("ImportTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockImportTemplateBundle.mockReset();
    mockRevalidate.mockReset();
    mockRevalidate.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  test("renders structured import errors parsed from GraphQL-style nested payloads", async () => {
    const error = new Error("Bundle validation failed");
    Object.assign(error, {
      extensions: {
        data: JSON.stringify({
          errors: [
            {
              error_code: "BUNDLE_MISSING_FILE",
              path: "manifest.json",
              human_message: "manifest.json is required",
            },
          ],
        }),
      },
    });
    mockImportTemplateBundle.mockRejectedValue(error);

    const { container } = renderWithFacade(<ImportTab />);
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["zip-content"], "broken-bundle.zip", {
      type: "application/zip",
    });

    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByText("Upload & Validate"));

    await waitFor(() => {
      expect(mockImportTemplateBundle).toHaveBeenCalledWith(file);
      expect(screen.getByText("Import Failed")).toBeTruthy();
      expect(screen.getByText("Bundle validation failed")).toBeTruthy();
      expect(screen.getByText("manifest.json is required")).toBeTruthy();
      expect(screen.getByText("BUNDLE_MISSING_FILE")).toBeTruthy();
      expect(screen.getAllByText("manifest.json").length).toBeGreaterThan(0);
      expect(notifyMock.error).toHaveBeenCalledWith({
        title: "Import failed: Bundle validation failed",
      });
    });
  });

  test("renders legacy detected snapshot format as Myoxus operator copy", async () => {
    mockImportTemplateBundle.mockResolvedValue({
      admin: {
        importTemplate: {
          entry: { id: "tpl-1", title: "Imported", slug: "imported" },
          revision: { id: "rev-1", version: "1.0.0", state: "VALIDATED" },
          detectedFormat: "upstream_snapshot_zip",
          normalized: true,
          ignoredEntriesCount: 0,
          warnings: [],
        },
      },
    });

    const { container } = renderWithFacade(<ImportTab />);
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["zip-content"], "snapshot-export.zip", {
      type: "application/zip",
    });

    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByText("Upload & Validate"));

    await waitFor(() => {
      expect(mockImportTemplateBundle).toHaveBeenCalledWith(file);
      expect(
        screen.getAllByText("Snapshot export ZIP without manifest").length,
      ).toBeGreaterThan(0);
      expect(screen.queryByText("upstream_snapshot_zip")).toBeNull();
    });
  });

  test("partial package persistence shows its real children and permits a complete retry", async () => {
    const documents = Array.from({ length: 5 }, (_, index) => ({
      entry: {
        id: `guide-${index}`,
        slug: `guide-${index}`,
        title: `Retained guide ${index}`,
      },
      revision: {
        id: `revision-${index}`,
        version: "1.0.0",
        state: "Published",
      },
    }));
    const result = {
      entry: null,
      revision: null,
      package: { package_id: "myoxus-onboarding", version: "1.0.0" },
      warnings: [],
      detectedFormat: "onboarding_package",
    };
    mockImportTemplateBundle.mockResolvedValueOnce({
      admin: {
        importTemplate: {
          ...result,
          documents: documents.slice(0, 2),
          error: "Storage unavailable",
        },
      },
    });
    const { container } = renderWithFacade(<ImportTab />);
    const file = new File(["package"], "onboarding.zip");
    fireEvent.change(container.querySelector('input[type="file"]')!, {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload & Validate" }));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(3));
    expect(screen.getByText("Storage unavailable").textContent).toBe(
      "Storage unavailable",
    );
    expect(screen.getByText("Guide package:").textContent).toBe(
      "Guide package:",
    );
    expect(screen.queryByText("Import Successful")).toBeNull();
    expect(notifyMock.success).not.toHaveBeenCalled();
    expect(notifyMock.error).toHaveBeenCalled();
    mockImportTemplateBundle.mockResolvedValueOnce({
      admin: { importTemplate: { ...result, documents, error: null } },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload & Validate" }));
    await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(6));
    expect(mockImportTemplateBundle).toHaveBeenNthCalledWith(2, file);
    expect(screen.queryByText("Storage unavailable")).toBeNull();
    expect(notifyMock.success).toHaveBeenCalledWith({
      title: "Imported 5 guides",
    });
  });
});
