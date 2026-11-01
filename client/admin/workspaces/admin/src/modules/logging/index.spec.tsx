import type { ReactElement } from "react";
/** @vitest-environment happy-dom */
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

// Mock useQuery to return test logging config
const mockLoggingConfig = {
  modules: [
    {
      group: "api",
      displayName: "API & Handlers",
      level: "info",
      recommendedDefault: "info",
      description: "REST/GraphQL request handling",
      highVolumeWarning: false,
    },
    {
      group: "database",
      displayName: "Database",
      level: "warn",
      recommendedDefault: "warn",
      description: "SQL queries",
      highVolumeWarning: true,
    },
  ],
  output: {
    filePath: "/opt/myoxus/logs/myoxus.log",
    rotation: "Daily",
    maxFiles: 7,
    pathValid: true,
    pathError: null,
  },
  recentChanges: [],
  diskUsage: {
    totalBytes: 1048576,
    fileCount: 3,
    freeBytes: 10737418240,
  },
};

const queryState = vi.hoisted(() => ({
  ready: true,
  error: undefined as Error | undefined,
  isValidating: false,
  mutate: vi.fn(async () => undefined),
}));

vi.mock("../../use-query", () => ({
  useQuery: () =>
    queryState.ready
      ? {
          ...queryState,
          data: { admin: { loggingConfig: mockLoggingConfig } },
          isLoading: false,
        }
      : { ...queryState, data: undefined, isLoading: !queryState.error },
  gqlFetcher: vi.fn(),
}));

// Shared mock triggers — tests can assert on these
const mockTriggerUpdateLevel = vi.fn().mockResolvedValue({});
const mockTriggerPreset = vi.fn().mockResolvedValue({});
const mockTriggerReset = vi.fn().mockResolvedValue({});
const mockTriggerUpdateOutput = vi.fn().mockResolvedValue({});

// Track which mutation is being initialized to return the correct trigger
vi.mock("../../use-mutation", () => ({
  useMutation: (opts: any) => {
    const id = opts?.mutation?.id ?? "";
    if (
      id.includes("updateLogModuleLevel") ||
      id === "updateLogModuleLevelMutation"
    ) {
      return { trigger: mockTriggerUpdateLevel };
    }
    if (id.includes("applyLogPreset") || id === "applyLogPresetMutation") {
      return { trigger: mockTriggerPreset };
    }
    if (id.includes("resetLogLevels") || id === "resetLogLevelsMutation") {
      return { trigger: mockTriggerReset };
    }
    if (id.includes("updateLogOutput") || id === "updateLogOutputMutation") {
      return { trigger: mockTriggerUpdateOutput };
    }
    return { trigger: vi.fn().mockResolvedValue({}) };
  },
  useMutateQueryResource: () => vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../panel/context", () => ({
  usePanelContext: () => ({
    setPanelContent: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    isOpen: false,
    hasDirtyChanges: false,
    setHasDirtyChanges: vi.fn(),
  }),
  useRightPanel: () => ({
    setPanelContent: vi.fn(),
    openPanel: vi.fn(),
    closePanel: vi.fn(),
    isOpen: false,
    hasDirtyChanges: false,
    setHasDirtyChanges: vi.fn(),
  }),
  useLeftPanel: () => ({
    togglePanel: vi.fn(),
    isOpen: true,
  }),
}));

import { LoggingContent } from "./index";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("LoggingContent", () => {
  beforeEach(() => {
    queryState.ready = true;
    queryState.error = undefined;
    queryState.isValidating = false;
    queryState.mutate.mockClear();
    (globalThis as any).environment = {
      subPath: "",
    };
  });

  afterEach(() => {
    cleanup();
    mockTriggerUpdateLevel.mockClear();
    mockTriggerPreset.mockClear();
    mockTriggerReset.mockClear();
    mockTriggerUpdateOutput.mockClear();
  });

  test("changing rotation sends existing server mutation value", () => {
    renderWithFacade(<LoggingContent />);

    const rotationInput = screen.getByRole("combobox", {
      name: "Rotation",
    });
    fireEvent.mouseDown(rotationInput);
    fireEvent.click(rotationInput);
    fireEvent.click(screen.getByRole("option", { name: "Hourly" }));

    expect(mockTriggerUpdateOutput).toHaveBeenCalledWith({
      input: { rotation: "HOURLY" },
    });
  });

  // --- Mutation tests (P1-2) ---

  test("clicking Production preset button triggers applyLogPreset mutation", () => {
    renderWithFacade(<LoggingContent />);

    const productionBtn = screen.getByText("Production");
    fireEvent.click(productionBtn);

    expect(mockTriggerPreset).toHaveBeenCalledWith({ preset: "production" });
  });

  test("clicking Reset button triggers resetLogLevels mutation", () => {
    renderWithFacade(<LoggingContent />);

    const resetBtn = screen.getByText("Reset");
    fireEvent.click(resetBtn);

    expect(mockTriggerReset).toHaveBeenCalledWith();
  });

  test("changing max files and blurring triggers updateLogOutput mutation", () => {
    renderWithFacade(<LoggingContent />);

    const maxFilesInput = screen.getByDisplayValue("7");
    fireEvent.change(maxFilesInput, { target: { value: "14" } });
    fireEvent.blur(maxFilesInput);

    expect(mockTriggerUpdateOutput).toHaveBeenCalledWith({
      input: { maxFiles: 14 },
    });
  });

  // ─── P97-B-08: SSE Live Tail test ───

  test("P97-B-08: clicking Connect opens EventSource to basepath-aware /api/admin/logs/tail", () => {
    (globalThis as any).environment = {
      subPath: "/adminfrontend",
    };
    // Mock EventSource
    const mockAddEventListenerMap: Record<string, EventListener> = {};
    const mockClose = vi.fn();
    const mockEventSource = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      close: mockClose,
      addEventListener: (type: string, listener: EventListener) => {
        mockAddEventListenerMap[type] = listener;
      },
    };
    const EventSourceSpy = vi.fn(function EventSourceMock() {
      return mockEventSource;
    });
    vi.stubGlobal("EventSource", EventSourceSpy);

    renderWithFacade(<LoggingContent />);

    // Click Connect to open the SSE stream
    fireEvent.click(screen.getByText("Connect"));

    // Invariant: EventSource was opened to the correct endpoint and keeps
    // self-host basepath deployments working.
    expect(EventSourceSpy).toHaveBeenCalledWith(
      "/adminfrontend/api/admin/logs/tail",
    );

    vi.unstubAllGlobals();
  });

  test("P97-B-08: SSE message event appends log line to terminal", async () => {
    const mockClose = vi.fn();
    let capturedOnMessage: ((event: MessageEvent) => void) | null = null;
    const mockEventSource = {
      get onmessage() {
        return capturedOnMessage;
      },
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        capturedOnMessage = handler;
      },
      onerror: null,
      close: mockClose,
    };
    vi.stubGlobal(
      "EventSource",
      vi.fn(function EventSourceMock() {
        return mockEventSource;
      }),
    );

    renderWithFacade(<LoggingContent />);
    fireEvent.click(screen.getByText("Connect"));

    // Simulate an SSE message with a unique marker
    const markerLine =
      "2026-04-01T12:00:00Z INFO test-marker-uuid: hello world";
    await act(async () => {
      if (capturedOnMessage) {
        capturedOnMessage(new MessageEvent("message", { data: markerLine }));
      }
    });

    // Invariant: the log line appears in the rendered output
    await waitFor(() => {
      const terminal = screen.getByTestId("logging-live-terminal");
      expect(terminal).toBeTruthy();
      expect(terminal!.textContent).toContain("test-marker-uuid");
    });

    vi.unstubAllGlobals();
  });
});
