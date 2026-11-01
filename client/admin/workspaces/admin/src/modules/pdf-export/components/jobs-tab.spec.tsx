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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import enJson from "../../../../../../../libs/i18n/src/resources/en.json";

const en: Record<string, string> = enJson;
const mutateJobs = vi.fn();
const cancelJob = vi
  .fn()
  .mockResolvedValue({ admin: { cancelPdfExportJob: true } });
const querySpy = vi.fn();
const mockJobState = {
  empty: false,
  error: null as Error | null,
  isLoading: false,
  isValidating: false,
};
const notifyMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
let eventListeners: Record<string, EventListener> = {};
const eventSourceClose = vi.fn();

vi.mock("@myoxus/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => en[key] ?? key,
    exists: (key: string) => key in en,
    language: "en",
    changeLanguage: () => Promise.resolve(),
  }),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("../../../components/shared/admin-confirm-modal", () => ({
  AdminConfirmModal: ({ open, title, onConfirm }: any) =>
    open ? (
      <div data-testid="admin-confirm-modal">
        <p>{title}</p>
        <button onClick={onConfirm}>confirm cancel</button>
      </div>
    ) : null,
}));

vi.mock("../api", () => ({
  useAdminPdfExportJobsQuery: (filters: any) => {
    querySpy(filters);
    return {
      ...mockJobState,
      jobs: mockJobState.empty
        ? []
        : [
            {
              id: "job-queued",
              workspaceId: "ws-1",
              docId: "doc-1",
              requestedBy: "user-1",
              requestedByEmail: "editor@example.com",
              requestedByName: "Editor",
              templateId: "tpl-1",
              status: "queued",
              syncOrAsync: "async",
              pageCount: null,
              errorClass: null,
              errorDetail: null,
              createdAt: "2026-05-01T10:00:00Z",
              startedAt: null,
              finishedAt: null,
              expiresAt: null,
              durationMs: null,
              unmappedFontFamilies: [],
              audit: null,
            },
            {
              id: "job-done",
              workspaceId: "ws-1",
              docId: "doc-2",
              requestedBy: "user-2",
              requestedByEmail: null,
              requestedByName: "Writer",
              templateId: "report",
              status: "done",
              syncOrAsync: "sync",
              pageCount: 4,
              errorClass: null,
              errorDetail: null,
              createdAt: "2026-05-01T09:55:00Z",
              startedAt: "2026-05-01T09:55:01Z",
              finishedAt: "2026-05-01T09:55:04Z",
              expiresAt: "2026-05-02T09:55:04Z",
              durationMs: 3000,
              unmappedFontFamilies: [],
              audit: {
                id: "audit-1",
                templateVersion: "1.2.3",
                renderAppearanceHash: "abc123",
                locale: "en",
                classification: "Internal",
                l3Inputs: { paperSize: "A4" },
                createdAt: "2026-05-01T09:55:00Z",
              },
            },
          ],
      mutate: mutateJobs,
    };
  },
  useCancelPdfExportJobMutation: () => ({ trigger: cancelJob }),
}));

import { JobsTab } from "./jobs-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function selectComboboxOption(name: string) {
  fireEvent.click(screen.getByRole("combobox"));
  fireEvent.click(await screen.findByRole("option", { name }));
}

describe("JobsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJobState.empty = false;
    mockJobState.error = null;
    mockJobState.isLoading = false;
    mockJobState.isValidating = false;
    mutateJobs.mockReset().mockResolvedValue(undefined);
    cancelJob.mockResolvedValue({ admin: { cancelPdfExportJob: true } });
    eventListeners = {};
    vi.stubGlobal(
      "EventSource",
      vi.fn(function EventSourceMock() {
        return {
          addEventListener: (type: string, listener: EventListener) => {
            eventListeners[type] = listener;
          },
          removeEventListener: vi.fn(),
          close: eventSourceClose,
          onerror: null,
        };
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  test("renders recent render jobs and status filters", async () => {
    renderWithFacade(<JobsTab />);

    expect(screen.getByText("editor@example.com")).toBeTruthy();
    expect(screen.getByText("report")).toBeTruthy();
    expect(screen.getByPlaceholderText("Workspace ID")).toBeTruthy();
    expect(screen.getByPlaceholderText("User ID")).toBeTruthy();
    expect(screen.queryByPlaceholderText("workspace uuid")).toBeNull();
    expect(screen.queryByPlaceholderText("user uuid")).toBeNull();
    expect(screen.getByLabelText("Created after").getAttribute("lang")).toBe(
      "en",
    );
    expect(screen.getByLabelText("Created before").getAttribute("lang")).toBe(
      "en",
    );

    await selectComboboxOption(en["admin.pdf-jobs.status.failed"]);
    expect(querySpy).toHaveBeenLastCalledWith({
      status: "failed",
      workspaceId: undefined,
      userId: undefined,
      createdAfter: undefined,
      createdBefore: undefined,
      limit: 100,
    });
  });

  test("subscribes to the render-jobs SSE invalidation stream", () => {
    const EventSourceSpy = EventSource as unknown as ReturnType<typeof vi.fn>;

    renderWithFacade(<JobsTab />);

    expect(EventSourceSpy).toHaveBeenCalledWith(
      "/api/admin/pdf-export/jobs/events",
    );
    eventListeners.jobs(new MessageEvent("jobs", { data: "{}" }));
    expect(mutateJobs).toHaveBeenCalledWith(undefined, { throwOnError: false });
  });

  test("opens the audit detail drawer", async () => {
    renderWithFacade(<JobsTab />);

    fireEvent.click(screen.getAllByRole("button", { name: "Details" })[1]);

    await waitFor(() => {
      expect(screen.getByText("Render audit")).toBeTruthy();
      expect(screen.getByText("abc123")).toBeTruthy();
      expect(screen.getByText(/paperSize/)).toBeTruthy();
    });
  });

  test("cancels queued jobs through the mutation", async () => {
    renderWithFacade(<JobsTab />);

    fireEvent.click(screen.getAllByRole("button", { name: "Cancel" })[0]);
    fireEvent.click(screen.getByText("confirm cancel"));

    await waitFor(() => {
      expect(cancelJob).toHaveBeenCalledWith({ jobId: "job-queued" });
      expect(mutateJobs).toHaveBeenCalled();
    });
  });
});
