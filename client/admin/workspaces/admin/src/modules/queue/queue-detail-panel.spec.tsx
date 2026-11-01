import type { ReactElement } from "react";
// SPDX-License-Identifier: AGPL-3.0-or-later

/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import userEvent from "@testing-library/user-event";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mockFetchQueueJobs = vi.fn();
const mockRetryQueueJob = vi.fn().mockResolvedValue(undefined);
const mockPromoteQueueJob = vi.fn().mockResolvedValue(undefined);

vi.mock("@myoxus/i18n", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/i18n")>();
  const { default: en } =
    await import("../../../../../../libs/i18n/src/resources/en.json");
  const translate = (key: string, values: Record<string, unknown> = {}) => {
    let text = (en as Record<string, string>)[key] ?? key;
    for (const [name, value] of Object.entries(values))
      text = text.replaceAll(`{{${name}}}`, String(value));
    return text;
  };
  return {
    ...actual,
    useI18n: () =>
      new Proxy(
        { t: translate, language: "en" },
        {
          get: (target, key: string) =>
            key in target
              ? target[key as keyof typeof target]
              : (values?: Record<string, unknown>) => translate(key, values),
        },
      ),
  };
});

const notifyMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}));

vi.mock("@myoxus/ui-facade", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, notify: notifyMock };
});

vi.mock("./queue-api", () => ({
  fetchQueueJobs: (...args: unknown[]) => mockFetchQueueJobs(...args),
  retryQueueJob: (...args: unknown[]) => mockRetryQueueJob(...args),
  promoteQueueJob: (...args: unknown[]) => mockPromoteQueueJob(...args),
}));

import { QueueDetailPanel } from "./queue-detail-panel";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

async function selectStatus(name: string) {
  const user = userEvent.setup();
  const input = screen.getByRole("combobox", { name: "Status" });
  await user.click(input);
  expect(input.getAttribute("aria-expanded")).toBe("true");
  const steps = ["Waiting", "Active", "Completed", "Failed", "Delayed"].indexOf(
    name,
  );
  for (let index = 0; index < steps; index++)
    await user.keyboard("{ArrowDown}");
  await user.keyboard("{Enter}");
  expect((input as HTMLInputElement).value).toBe(name);
}

function jobListResponse(
  jobs: Array<Record<string, unknown>>,
  nextCursor: number | null = null,
) {
  return {
    totalCount: jobs.length,
    numOfPages: jobs.length > 0 ? 1 : 0,
    nextCursor,
    jobs,
  };
}

describe("QueueDetailPanel", () => {
  beforeEach(() => {
    (globalThis as any).environment = { subPath: "" };
  });

  afterEach(() => {
    cleanup();
    mockFetchQueueJobs.mockReset();
    mockRetryQueueJob.mockClear();
    mockPromoteQueueJob.mockClear();
    vi.restoreAllMocks();
  });

  test("failed jobs expose a visible retry action that calls the queue API", async () => {
    mockFetchQueueJobs
      .mockResolvedValueOnce(jobListResponse([]))
      .mockResolvedValue(
        jobListResponse([
          {
            id: "failed-1",
            name: "deliver-webhook",
            timestamp: Date.UTC(2026, 0, 2, 3, 4, 5),
            attemptsMade: 3,
            failedReason: "timeout",
          },
        ]),
      );

    renderWithFacade(
      <QueueDetailPanel queueName="notification" onClose={vi.fn()} />,
    );

    await selectStatus("Failed");

    await waitFor(() => {
      expect(screen.getByText("deliver-webhook").textContent).toBe(
        "deliver-webhook",
      );
    });
    fireEvent.click(screen.getByRole("button", { name: /Retry job/i }));

    await waitFor(() => {
      expect(mockRetryQueueJob).toHaveBeenCalledWith(
        "notification",
        "failed-1",
      );
    });
  });

  test.each([
    {
      category: "organizer order",
      errorMessage: "workspace content organizer order needs repair",
      explanation: /folder order contains invalid positions/i,
    },
    {
      category: "document identity conflict",
      errorMessage: "workspace content Move target Document key conflicts",
      explanation: /document with the same identifier already exists/i,
    },
  ])(
    "a completed queue envelope exposes the failed operation and $category explanation",
    async ({ errorMessage, explanation }) => {
      mockFetchQueueJobs.mockResolvedValue(
        jobListResponse([
          {
            id: "old-redis-job",
            name: "workspace-content-operation",
            timestamp: 1,
            attemptsMade: 1,
            workspaceContentOperation: {
              id: "operation-diagnostic-123",
              status: "Failed",
              errorMessage,
            },
          },
        ]),
      );
      renderWithFacade(
        <QueueDetailPanel
          queueName="workspace-content-operation"
          onClose={vi.fn()}
        />,
      );
      await selectStatus("Completed");
      expect(
        (await screen.findByText("Workspace operation: Failed")).textContent,
      ).toBe("Workspace operation: Failed");
      expect(
        screen.getByText(/operation-diagnostic-123/).textContent,
      ).toContain("operation-diagnostic-123");
      expect(screen.getByText(explanation)).not.toBeNull();
      expect(screen.queryByText(errorMessage)).toBeNull();
      expect(screen.queryByRole("button", { name: /Retry job/i })).toBeNull();
    },
  );

  test("a failed fetch is not presented as an empty queue", async () => {
    mockFetchQueueJobs.mockRejectedValue(new Error("private transport detail"));
    renderWithFacade(
      <QueueDetailPanel queueName="workspace" onClose={vi.fn()} />,
    );
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Jobs could not be loaded",
    );
    expect(screen.queryByText("private transport detail")).toBeNull();
    expect(screen.queryByText(/0 jobs/)).toBeNull();
    expect(screen.queryByText(/Loading/)).toBeNull();
  });

  test("a late response from an old status cannot replace the selected status", async () => {
    let resolveWaiting!: (value: ReturnType<typeof jobListResponse>) => void;
    mockFetchQueueJobs.mockImplementation(({ status }) =>
      status === "waiting"
        ? new Promise((resolve) => {
            resolveWaiting = resolve;
          })
        : Promise.resolve(
            jobListResponse([{ id: "delayed-1", name: "current-job" }]),
          ),
    );
    const onClose = vi.fn();
    renderWithFacade(
      <QueueDetailPanel queueName="nightly" onClose={onClose} />,
    );
    await selectStatus("Delayed");
    await screen.findByText("current-job");
    await act(async () => {
      resolveWaiting(jobListResponse([{ id: "waiting-1", name: "stale-job" }]));
    });
    await waitFor(() => {
      expect(screen.queryByText("stale-job")).toBeNull();
      expect(
        (screen.getByRole("combobox", { name: "Status" }) as HTMLInputElement)
          .value,
      ).toBe("Delayed");
    });
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  test("pagination resets when changing status and delayed jobs retain promotion", async () => {
    mockFetchQueueJobs.mockResolvedValue(
      jobListResponse([{ id: "job-1", name: "scheduled-job" }], 20),
    );
    renderWithFacade(
      <QueueDetailPanel queueName="nightly" onClose={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(mockFetchQueueJobs).toHaveBeenCalledWith({
        queueName: "nightly",
        status: "waiting",
        cursor: 20,
        limit: 20,
      }),
    );
    await screen.findByRole("button", { name: "Next" });
    await selectStatus("Delayed");
    await waitFor(() =>
      expect(mockFetchQueueJobs).toHaveBeenLastCalledWith({
        queueName: "nightly",
        status: "delayed",
        cursor: 0,
        limit: 20,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Promote job/i }),
    );
    await waitFor(() =>
      expect(mockPromoteQueueJob).toHaveBeenCalledWith("nightly", "job-1"),
    );
  });
});
