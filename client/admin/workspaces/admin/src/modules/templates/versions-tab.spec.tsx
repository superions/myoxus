import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
import { RevisionStateType } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockPublishTrigger = vi.fn().mockResolvedValue({});
const mockRevalidate = vi.fn().mockResolvedValue(undefined);
const mockFetch = vi.fn();
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));

const mockQueryData: Record<string, any> = {};

vi.mock("./api", () => ({
  usePublishRevisionMutation: () => ({
    trigger: mockPublishTrigger,
    isMutating: false,
  }),
  useTemplateCatalogQuery: () => {
    const defaultCatalog = [
      { id: "tpl-1", title: "Test Template", slug: "test-tpl" },
    ];
    const catalog = mockQueryData.catalog;
    const entries = Array.isArray(catalog)
      ? catalog
      : (catalog?.admin?.templateCatalog ?? defaultCatalog);
    const totalCount = Array.isArray(catalog)
      ? catalog.length
      : (catalog?.admin?.templateCatalogCount ?? entries.length);
    return { entries, totalCount };
  },
  useTemplateRevisionsQuery: () => {
    const defaultRevisions = [
      {
        id: "rev-1",
        version: "1.0.0",
        state: RevisionStateType.Validated,
        publishedAt: null,
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "rev-2",
        version: "0.9.0",
        state: RevisionStateType.Published,
        publishedAt: "2026-01-01T00:00:00Z",
        createdAt: "2025-12-15T00:00:00Z",
      },
    ];
    const revisions = Array.isArray(mockQueryData.revisions)
      ? mockQueryData.revisions
      : (mockQueryData.revisions?.admin?.templateRevisions ?? defaultRevisions);
    return { revisions };
  },
  useTemplateRegistryRevalidate: () => ({
    revalidateCatalog: mockRevalidate,
    revalidateRevisions: mockRevalidate,
    revalidateJobs: mockRevalidate,
  }),
}));

vi.mock("../../components/shared/admin-confirm-modal", () => ({
  AdminConfirmModal: ({ open, title, onConfirm, confirmText }: any) =>
    open ? (
      <div data-testid="admin-confirm-modal">
        <div data-testid="admin-confirm-modal-title">{title}</div>
        <button data-testid="admin-confirm-modal-confirm" onClick={onConfirm}>
          {confirmText}
        </button>
      </div>
    ) : null,
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

import { VersionsTab } from "./versions-tab";

function createFetchResponse({
  ok = true,
  status = 200,
  headers = new Headers(),
  body = new Blob(["zip-bytes"], { type: "application/zip" }),
}: {
  ok?: boolean;
  status?: number;
  headers?: Headers;
  body?: Blob;
} = {}): Response {
  return {
    ok,
    status,
    headers,
    blob: vi.fn().mockResolvedValue(body),
    json: vi.fn(),
    text: vi.fn().mockResolvedValue(""),
  } as unknown as Response;
}

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function selectDefaultTemplate() {
  const trigger = screen.getByPlaceholderText("Select a template...");
  fireEvent.mouseDown(trigger);
  fireEvent.click(trigger);
  fireEvent.click(
    await screen.findByRole("option", {
      name: "Test Template (test-tpl)",
    }),
  );
}

describe("VersionsTab", () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalEnvironment = (globalThis as any).environment;
  const createObjectURLSpy = vi.fn(() => "blob:test-download");
  const revokeObjectURLSpy = vi.fn();
  const clickedDownloads: Array<{ download: string; href: string }> = [];
  let anchorClickSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishTrigger.mockReset();
    mockPublishTrigger.mockResolvedValue({});
    mockRevalidate.mockReset();
    mockRevalidate.mockResolvedValue(undefined);
    mockFetch.mockReset();
    clickedDownloads.length = 0;
    (globalThis as any).environment = undefined;

    vi.stubGlobal("fetch", mockFetch);
    URL.createObjectURL = createObjectURLSpy;
    URL.revokeObjectURL = revokeObjectURLSpy;
    anchorClickSpy = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        clickedDownloads.push({
          download: this.download,
          href: this.href,
        });
      });
  });

  afterEach(() => {
    cleanup();
    anchorClickSpy.mockRestore();
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    (globalThis as any).environment = originalEnvironment;
    vi.unstubAllGlobals();
    delete mockQueryData.catalog;
    delete mockQueryData.revisions;
  });

  test("shows Publish button only for server-validated revisions", async () => {
    renderWithFacade(<VersionsTab />);
    await selectDefaultTemplate();

    expect(screen.getAllByText("Publish")).toHaveLength(1);
  });

  test("clicking Export downloads the REST bundle using the response filename", async () => {
    mockFetch.mockResolvedValue(
      createFetchResponse({
        headers: new Headers({
          "content-type": "application/zip",
          "content-disposition":
            'attachment; filename="template-weekly-standup-1.0.0.zip"',
        }),
      }),
    );

    renderWithFacade(<VersionsTab />);
    await selectDefaultTemplate();
    fireEvent.click(screen.getAllByText("Export")[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/admin/templates/export/rev-1",
        expect.objectContaining({
          credentials: "include",
          headers: expect.any(Headers),
        }),
      );
    });
    await waitFor(() => {
      expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
      expect(clickedDownloads).toEqual([
        {
          download: "template-weekly-standup-1.0.0.zip",
          href: "blob:test-download",
        },
      ]);
      expect(revokeObjectURLSpy).toHaveBeenCalledWith("blob:test-download");
      expect(notifyMock.success).toHaveBeenCalledWith({
        title: "Revision exported successfully.",
      });
    });
  });

  test("clicking Export respects runtime subPath prefix when configured", async () => {
    (globalThis as any).environment = { subPath: "/adminfrontend" };
    mockFetch.mockResolvedValue(
      createFetchResponse({
        headers: new Headers({
          "content-type": "application/zip",
          "content-disposition":
            'attachment; filename="template-weekly-standup-1.0.0.zip"',
        }),
      }),
    );

    renderWithFacade(<VersionsTab />);
    await selectDefaultTemplate();
    fireEvent.click(screen.getAllByText("Export")[0]);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/adminfrontend/api/admin/templates/export/rev-1",
        expect.objectContaining({
          credentials: "include",
          headers: expect.any(Headers),
        }),
      );
    });
  });
});
