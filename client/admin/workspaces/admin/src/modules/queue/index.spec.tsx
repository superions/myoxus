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

const useAdminCapabilitiesMock = vi.fn();
const useAppConfigMock = vi.fn();

vi.mock("../header", () => ({
  Header: ({ title }: { title: string }) => <div>{title}</div>,
}));

const mockSetPanelContent = vi.fn();
const mockOpenPanel = vi.fn();
vi.mock("../panel/context", () => ({
  useRightPanel: () => ({
    setPanelContent: mockSetPanelContent,
    openPanel: mockOpenPanel,
    closePanel: vi.fn(),
    isOpen: false,
  }),
}));

vi.mock("../settings/use-app-config", () => ({
  useAppConfig: () => useAppConfigMock(),
}));

vi.mock("../common", () => ({
  useRevalidateServerConfig: () => vi.fn(),
  useAdminCapabilities: () => useAdminCapabilitiesMock(),
  // AF-PERF-A-04: useAdminContext delegates capabilities to the same mock
  useAdminContext: () => ({
    capabilities: useAdminCapabilitiesMock(),
    serverConfig: null,
  }),
}));

vi.mock("../settings/config", () => ({
  ALL_CONFIG_DESCRIPTORS: {
    job: {
      // Presentation metadata for the server-owned canonical descriptors.
      "queue.attempts": { type: "Number", desc: "Max retry attempts per job" },
      "queue.removeOnComplete": {
        type: "Boolean",
        desc: "Remove completed jobs",
      },
      "queue.backoff.type": {
        type: "String",
        desc: "Backoff strategy",
        enum: ["exponential", "fixed"],
      },
      "queue.backoff.delay": { type: "Number", desc: "Backoff delay (ms)" },
      "queue.removeOnFail.age": {
        type: "Number",
        desc: "Max age of failed jobs (s)",
      },
      "queue.removeOnFail.count": {
        type: "Number",
        desc: "Max failed jobs to retain",
      },
      "worker.pollTimeoutSeconds": {
        type: "Number",
        desc: "Worker poll timeout (s)",
      },
      "queues.copilot": {
        type: "JSON",
        desc: "Per-queue config for AI copilot jobs",
      },
      "queues.doc": {
        type: "JSON",
        desc: "Per-queue config for document maintenance jobs",
      },
      "queues.indexer": {
        type: "JSON",
        desc: "Per-queue config for search indexer jobs",
      },
      "queues.document-graph": {
        type: "JSON",
        desc: "Per-queue config for document graph reindex jobs",
      },
      "queues.notification": {
        type: "JSON",
        desc: "Per-queue config for notification delivery jobs",
      },
      "queues.nightly": {
        type: "JSON",
        desc: "Per-queue config for nightly maintenance jobs",
      },
      "queues.calendar-reminder": {
        type: "JSON",
        desc: "Per-queue config for calendar reminder jobs",
      },
      "queues.git-sync": {
        type: "JSON",
        desc: "Per-queue config for git synchronization jobs",
      },
      "queues.template-registry": {
        type: "JSON",
        desc: "Per-queue config for template registry jobs",
      },
      "queues.caldav-sync": {
        type: "JSON",
        desc: "Per-queue config for CalDAV sync jobs",
      },
      "queues.google-calendar-sync": {
        type: "JSON",
        desc: "Per-queue config for Google Calendar sync jobs",
      },
      "queues.pdf-export": {
        type: "JSON",
        desc: "Per-queue config for PDF export jobs",
      },
      "queues.database": {
        type: "JSON",
        desc: "Per-queue config for database projection jobs",
      },
      "queues.workspace-automation": {
        type: "JSON",
        desc: "Per-queue config for workspace automation jobs",
      },
      "queues.workspace-content-operation": {
        type: "JSON",
        desc: "Per-queue config for cross-workspace content operations",
      },
    },
  },
}));

vi.mock("../settings/config-form-fields", () => {
  const field =
    (type: string) =>
    ({
      field,
      desc,
      defaultValue,
    }: {
      field: string;
      desc?: string;
      defaultValue?: unknown;
    }) => (
      <div
        data-testid={`config-field-${field}`}
        data-type={type}
        data-value={String(defaultValue ?? "")}
      >
        {desc}
      </div>
    );
  return {
    ConfigTextField: field("String"),
    ConfigNumberField: field("Number"),
    ConfigBooleanField: field("Boolean"),
    ConfigSelectField: field("Enum"),
    ConfigMultiSelectField: field("Array"),
    ConfigArrayField: field("Array"),
    ConfigJsonField: field("JSON"),
    ConfigCheckboxGroupField: field("CheckboxGroup"),
    ConfigRadioSelectField: field("RadioSelect"),
    ConfigColorField: field("Color"),
    YamlOnlyBanner: () => null,
  };
});

vi.mock("../settings/sensitive", () => ({
  isSensitiveConfigField: () => false,
}));

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

const mockFetchQueueStatus = vi.fn();
const mockPauseQueue = vi.fn().mockResolvedValue(undefined);
const mockResumeQueue = vi.fn().mockResolvedValue(undefined);
const mockPauseAllQueues = vi.fn().mockResolvedValue(undefined);
const mockResumeAllQueues = vi.fn().mockResolvedValue(undefined);
const mockCleanQueue = vi.fn().mockResolvedValue(undefined);
const mockEmptyQueue = vi.fn().mockResolvedValue(undefined);
vi.mock("./queue-api", () => ({
  fetchQueueStatus: (...args: any[]) => mockFetchQueueStatus(...args),
  pauseQueue: (...args: any[]) => mockPauseQueue(...args),
  resumeQueue: (...args: any[]) => mockResumeQueue(...args),
  pauseAllQueues: (...args: any[]) => mockPauseAllQueues(...args),
  resumeAllQueues: (...args: any[]) => mockResumeAllQueues(...args),
  cleanQueue: (...args: any[]) => mockCleanQueue(...args),
  emptyQueue: (...args: any[]) => mockEmptyQueue(...args),
}));

vi.mock("./queue-detail-panel", () => ({
  QueueDetailPanel: ({
    queueName,
  }: {
    queueName: string;
    onClose: () => void;
  }) => <div data-testid="queue-detail-panel">{queueName}</div>,
}));

import { QueuePage } from "./index";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("QueuePage", () => {
  beforeEach(() => {
    (globalThis as any).environment = {
      subPath: "",
    };
    useAdminCapabilitiesMock.mockReturnValue({
      hasQueueDashboard: true,
    });
    useAppConfigMock.mockReturnValue({
      appConfig: {},
      patchedAppConfig: {},
      update: vi.fn(),
      saveGroup: vi.fn().mockResolvedValue(undefined),
      saveField: vi.fn().mockResolvedValue(undefined),
      resetGroup: vi.fn(),
      isGroupDirty: () => false,
      isGroupSaving: () => false,
      getGroupVersion: () => 0,
      fieldErrorsByPath: {},
    });
  });

  afterEach(() => {
    cleanup();
    mockFetchQueueStatus.mockReset();
    mockPauseQueue.mockClear();
    mockResumeQueue.mockClear();
    mockPauseAllQueues.mockClear();
    mockResumeAllQueues.mockClear();
    mockCleanQueue.mockClear();
    mockEmptyQueue.mockClear();
    mockSetPanelContent.mockClear();
    mockOpenPanel.mockClear();
    vi.restoreAllMocks();
  });

  test("shows a banner when the queue dashboard capability is unavailable", async () => {
    useAdminCapabilitiesMock.mockReturnValue({
      hasQueueDashboard: false,
    });
    renderWithFacade(<QueuePage />);

    await waitFor(() => {
      expect(screen.getByText("Queue dashboard unavailable").textContent).toBe(
        "Queue dashboard unavailable",
      );
    });
    expect(mockFetchQueueStatus).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        "This server does not expose the queue dashboard capability, so the page stays open and the configuration tab remains available.",
      ).textContent,
    ).toBe(
      "This server does not expose the queue dashboard capability, so the page stays open and the configuration tab remains available.",
    );
  });

  test("shows error state on queue query failure", async () => {
    mockFetchQueueStatus.mockRejectedValueOnce(new Error("Network error"));

    renderWithFacade(<QueuePage />);

    await waitFor(() => {
      expect(screen.getByText("Queue dashboard unavailable").textContent).toBe(
        "Queue dashboard unavailable",
      );
    });
  });

  // --- Queue action tests (P1-3) ---

  function stubPopulatedQueues(
    history: { timestamp: number; pending: number }[] | null = null,
  ) {
    mockFetchQueueStatus.mockResolvedValue({
      redisAvailable: true,
      degraded: false,
      queues: [
        {
          name: "notification",
          displayName: "notification",
          degraded: false,
          paused: false,
          history,
          counts: {
            active: 2,
            completed: 10,
            delayed: 0,
            failed: 1,
            stalled: 0,
            waiting: 3,
          },
        },
      ],
    });
  }

  test("renders real queue history as an accessible inline native chart", async () => {
    stubPopulatedQueues([
      { timestamp: 60_000, pending: 5 },
      { timestamp: 120_000, pending: 0 },
    ]);
    renderWithFacade(<QueuePage />);
    const chart = await screen.findByRole("img", {
      name: /notification: pending jobs/,
    });
    expect(chart.getAttribute("data-myoxus-ui-role")).toBe("queue-history");
    expect(chart.getAttribute("aria-label")).toContain("Latest sample: 0");
    expect(chart.getAttribute("tabindex")).toBe("0");
    chart.focus();
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "Latest sample: 0",
    );
    chart.blur();
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
    expect(
      screen.getByRole("columnheader", { name: "Pending (24h)" }).textContent,
    ).toBe("Pending (24h)");
    expect(
      screen
        .getByRole("button", { name: "Queue actions" })
        .getAttribute("aria-label"),
    ).toBe("Queue actions");
  });

  test("does not render a misleading chart before history is available", async () => {
    stubPopulatedQueues([{ timestamp: 60_000, pending: 0 }]);
    renderWithFacade(<QueuePage />);
    await screen.findByRole("button", { name: "notification" });
    expect(screen.queryByRole("img")).toBeNull();
    expect(
      screen.getByLabelText(/trend appears after two minute samples/i)
        .textContent,
    ).toBe("—");
  });

  test("pause button calls the GraphQL pause mutation", async () => {
    stubPopulatedQueues();
    renderWithFacade(<QueuePage />);

    await waitFor(() => {
      expect(screen.getAllByText("notification").length).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByRole("button", { name: "Queue actions" }));
    const pauseBtn = await screen.findByRole("menuitem", {
      name: /Pause queue/i,
      hidden: true,
    });
    fireEvent.click(pauseBtn);

    await waitFor(() => {
      expect(mockPauseQueue).toHaveBeenCalledWith("notification");
    });
  });

  test("empty queue shows confirmation dialog and calls GraphQL empty on confirm", async () => {
    stubPopulatedQueues();
    renderWithFacade(<QueuePage />);

    await waitFor(() => {
      expect(screen.getAllByText("notification").length).toBeGreaterThan(0);
    });

    const triggers = screen.getAllByLabelText("Queue actions");
    expect(triggers).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Queue actions" }));

    const emptyBtn = await screen.findByRole("menuitem", {
      name: /Empty queue/i,
      hidden: true,
    });
    fireEvent.click(emptyBtn);

    // Confirmation dialog should appear (AlertDialog mock renders when open=true)
    await waitFor(() => {
      expect(screen.getByRole("dialog").getAttribute("role")).toBe("dialog");
    });

    // Click the confirm button (rendered by AlertDialogAction)
    const confirmBtn = screen.getByText("Empty");
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockEmptyQueue).toHaveBeenCalledWith("notification");
    });
  });

  test("clicking queue row opens detail panel", async () => {
    stubPopulatedQueues();
    renderWithFacade(<QueuePage />);

    await waitFor(() => {
      expect(screen.getAllByText("notification").length).toBeGreaterThan(0);
    });

    const queueRow = screen.getAllByText("notification")[0].closest("tr");
    expect(queueRow?.tagName).toBe("TR");
    fireEvent.click(queueRow!);

    expect(mockSetPanelContent).toHaveBeenCalled();
    expect(mockOpenPanel).toHaveBeenCalled();
    expect(mockSetPanelContent.mock.calls.at(-1)?.[0].key).toBe("notification");
  });

  test("keyboard events on queue actions do not open the detail panel", async () => {
    stubPopulatedQueues();
    renderWithFacade(<QueuePage />);
    const actions = await screen.findByRole("button", {
      name: "Queue actions",
    });
    fireEvent.keyDown(actions, { key: "Enter" });
    fireEvent.keyDown(actions, { key: " " });
    expect(mockSetPanelContent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "notification" }));
    expect(mockSetPanelContent).toHaveBeenCalledOnce();
  });

  // --- JobSettingsTab structured field tests ---

  // ─── P100-H-05c: Queue page shows initial defaults without prior config change ───

  test("P100-H-05c: queue settings fields display server defaults without prior config changes", async () => {
    // Invariant: When appConfig contains the server-side defaults, the queue
    // settings tab must display those values without the user making any changes.
    // This verifies that the 3-segment path extraction (job/queue/attempts)
    // correctly reads nested object values via getByPath.
    useAdminCapabilitiesMock.mockReturnValue({ hasQueueDashboard: false });

    // Provide the defaults under the same canonical paths returned by the server.
    const serverDefaults = {
      queue: {
        attempts: 5,
        removeOnComplete: true,
        backoff: { type: "exponential", delay: 1000 },
        removeOnFail: { age: 86400, count: 500 },
      },
      worker: { pollTimeoutSeconds: 5 },
      queues: {
        copilot: { concurrency: 2 },
        doc: { concurrency: 1 },
        indexer: { concurrency: 3 },
        "document-graph": { concurrency: 1 },
        notification: { concurrency: 4 },
        nightly: { concurrency: 1 },
        "calendar-reminder": { concurrency: 2 },
        "git-sync": { concurrency: 1 },
        "template-registry": { concurrency: 1 },
        "caldav-sync": { concurrency: 1 },
        "google-calendar-sync": { concurrency: 1 },
        "pdf-export": { concurrency: 1 },
        database: { concurrency: 1 },
        "workspace-automation": { concurrency: 1 },
        "workspace-content-operation": { concurrency: 1 },
      },
    };

    // Override useAppConfig mock for this test to provide server defaults
    useAppConfigMock.mockReturnValue({
      appConfig: { job: serverDefaults } as any,
      patchedAppConfig: { job: serverDefaults } as any,
      update: vi.fn(),
      saveGroup: vi.fn().mockResolvedValue(undefined),
      saveField: vi.fn().mockResolvedValue(undefined),
      resetGroup: vi.fn(),
      isGroupDirty: () => false,
      isGroupSaving: () => false,
      getGroupVersion: () => 0,
      fieldErrorsByPath: {},
    } as any);

    renderWithFacade(<QueuePage />);

    await waitFor(() => {
      // attempts default: 5 (job/queue/attempts — parentKey='queue', key='attempts')
      const attemptsField = screen.getByTestId(
        "config-field-job/queue/attempts",
      );
      expect(attemptsField.dataset.value).toBe("5");

      // backoff.type default: exponential (job/queue.backoff/type — parentKey='queue.backoff', key='type')
      const backoffTypeField = screen.getByTestId(
        "config-field-job/queue.backoff/type",
      );
      expect(backoffTypeField.dataset.value).toBe("exponential");

      // backoff.delay default: 1000 (job/queue.backoff/delay)
      const backoffDelayField = screen.getByTestId(
        "config-field-job/queue.backoff/delay",
      );
      expect(backoffDelayField.dataset.value).toBe("1000");

      // pollTimeoutSeconds default: 5 (job/worker/pollTimeoutSeconds)
      const workerField = screen.getByTestId(
        "config-field-job/worker/pollTimeoutSeconds",
      );
      expect(workerField.dataset.value).toBe("5");

      // Per-queue concurrency: copilot = 2 (job/queues.copilot/concurrency)
      const copilotField = screen.getByTestId(
        "config-field-job/queues.copilot/concurrency",
      );
      expect(copilotField.dataset.value).toBe("2");
    });
  });
});
