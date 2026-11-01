import type { ReactNode } from "react";
/** @vitest-environment happy-dom */
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const useQueryMock = vi.fn();
const mutateQueryResourceMock = vi.fn();

vi.mock("@myoxus/admin/use-query", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

vi.mock("../../use-mutation", () => ({
  useMutateQueryResource:
    () =>
    (...args: unknown[]) => {
      return mutateQueryResourceMock(...args);
    },
}));

vi.mock("../header", () => ({
  Header: ({ title, endFix }: { title: string; endFix?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      {endFix}
    </div>
  ),
}));

vi.mock("../operational-readiness-notice", () => ({
  OperationalReadinessNotice: () => null,
}));

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  Tooltip: ({ content }: { content?: ReactNode }) => (
    <div data-testid="chart-tooltip">{content}</div>
  ),
  Area: ({ children }: { children?: ReactNode }) => (
    <div data-testid="area">{children}</div>
  ),
  CartesianGrid: ({ children }: { children?: ReactNode }) => (
    <div data-testid="grid">{children}</div>
  ),
  Line: ({
    children,
    strokeLinecap,
    strokeLinejoin,
  }: {
    children?: ReactNode;
    strokeLinecap?: string;
    strokeLinejoin?: string;
  }) => (
    <div
      data-testid="line"
      data-stroke-linecap={strokeLinecap}
      data-stroke-linejoin={strokeLinejoin}
    >
      {children}
    </div>
  ),
  ComposedChart: ({
    children,
    data,
  }: {
    children?: ReactNode;
    data: unknown;
  }) => (
    <div data-testid="composed-chart" data-points={JSON.stringify(data)}>
      {children}
    </div>
  ),
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
}));

import { DashboardPage } from "./index";

function renderDashboard() {
  return render(
    <MyoxusUIProvider>
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    </MyoxusUIProvider>,
  );
}

const dashboardData = {
  admin: {
    adminDashboard: {
      syncActiveUsers: 3,
      syncActiveUsersTimeline: [
        { minute: "2026-02-16T10:30:00.000Z", activeUsers: 1 },
        { minute: "2026-02-16T10:31:00.000Z", activeUsers: 3 },
      ],
      syncWindow: {
        from: "2026-02-14T20:30:00.000Z",
        to: "2026-02-16T19:30:00.000Z",
        timezone: "UTC",
        bucket: "minute",
        requestedSize: 2880,
        effectiveSize: 2880,
      },
      copilotConversations: 7,
      workspaceStorageBytes: 375,
      blobStorageBytes: 1024,
      workspaceStorageHistory: [{ date: "2026-02-16", value: 375 }],
      blobStorageHistory: [{ date: "2026-02-16", value: 1024 }],
      storageWindow: {
        from: "2026-01-18T00:00:00.000Z",
        to: "2026-02-16T00:00:00.000Z",
        timezone: "UTC",
        bucket: "day",
        requestedSize: 30,
        effectiveSize: 30,
      },
      topSharedLinksWindow: {
        from: "2026-01-18T00:00:00.000Z",
        to: "2026-02-16T00:00:00.000Z",
        timezone: "UTC",
        bucket: "day",
        requestedSize: 30,
        effectiveSize: 30,
      },
      topSharedLinks: [],
      runtime: {
        processUptimeSeconds: 3661,
        requestsTotal: 1200,
        requestsErrorTotal: 3,
        requestErrorRate: 0.0025,
        requestThroughputRps: 0.4,
        requestLatencyAvgMs: 18.5,
        requestLatencyMaxMs: 250,
      },
      queueSummary: {
        pendingReadyTotal: 4,
        failedTotal: 0,
        queues: [
          {
            queue: "doc",
            pendingReady: 4,
            failed: 0,
            deadLetter: 0,
            queueLagSeconds: 0,
          },
        ],
      },
      metricsPipeline: {
        enabled: true,
        prometheusEnabled: true,
        persistenceEnabled: true,
        activeSeries: 9,
        persisted24H: 44,
        dailyRollups7D: 12,
        lastFlushAt: "2026-02-16T19:29:55.000Z",
        lastFlushCount: 8,
        flushIntervalSeconds: 60,
        offeredTotal: 100,
        acceptedTotal: 99,
        rejectedDisabledTotal: 0,
        cardinalityDropsTotal: 0,
      },
      telemetryPipeline: {
        enabled: true,
        hotBufferLen: 0,
        persisted24H: 20,
        dailyRollups7D: 2,
        lastFlushAt: "2026-02-16T19:29:55.000Z",
        lastFlushCount: 5,
        offeredTotal: 40,
        acceptedTotal: 38,
        rejectedTotal: 2,
        bufferOverflowTotal: 0,
        dedupeHitRate: 0.05,
      },
      captcha: {
        enabled: true,
        hmacKeyConfigured: true,
        verifiedTotal: 11,
        rejectedTotal: 1,
        honeypotTotal: 0,
      },
      dbPool: {
        active: 2,
        idle: 8,
        max: 10,
        userCount: 15,
        workspaceCount: 6,
      },
      cacheMetrics: [
        {
          name: "app_config",
          hitsTotal: 80,
          missesTotal: 20,
          hitRate: 0.8,
          invalidationsLocalTotal: 1,
          invalidationsRemoteTotal: 0,
          entryCount: 3,
        },
      ],
      generatedAt: "2026-02-16T19:30:00.000Z",
    },
  },
};

describe("DashboardPage", () => {
  beforeEach(() => {
    (globalThis as any).environment = {
      isSelfHosted: true,
    };
    useQueryMock.mockReset();
    useQueryMock.mockReturnValue({
      data: dashboardData,
      isValidating: false,
    });
    mutateQueryResourceMock.mockReset();
    mutateQueryResourceMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  test("manual refresh revalidates the same typed dashboard resource and variable scope", () => {
    renderDashboard();

    fireEvent.click(screen.getByText("Refresh"));

    expect(mutateQueryResourceMock).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining("requestThroughputRps"),
      }),
      expect.any(Function),
    );
    const varsFilter = mutateQueryResourceMock.mock.calls[0][1] as (
      vars: unknown,
    ) => boolean;
    expect(varsFilter(useQueryMock.mock.calls[0][0].variables)).toBe(true);
  });

  test("deep-links dashboard clusters to their owning admin tabs", () => {
    renderDashboard();

    const linkFor = (label: string) =>
      screen
        .getByRole("link", { name: `Details: ${label}` })
        .getAttribute("href");

    expect(linkFor("Security & Abuse")).toBe(
      "/adminfrontend/security?tab=captcha",
    );
    expect(linkFor("Metrics & Telemetry")).toBe(
      "/adminfrontend/system?tab=telemetry",
    );
  });

  test("renders dashboard graphs with composed rounded chart lines and sane meter scales", () => {
    renderDashboard();

    expect(screen.getAllByTestId("composed-chart")).toHaveLength(2);
    expect(screen.getAllByTestId("area")).toHaveLength(2);
    for (const line of screen.getAllByTestId("line")) {
      expect(line.getAttribute("data-stroke-linecap")).toBe("round");
      expect(line.getAttribute("data-stroke-linejoin")).toBe("round");
    }

    expect(
      screen
        .getByRole("progressbar", { name: "Requests/s: 0.4" })
        .getAttribute("aria-valuemax"),
    ).toBe("1");
    expect(
      screen
        .getByRole("progressbar", { name: "Avg latency: 18.5 ms" })
        .getAttribute("aria-valuemax"),
    ).toBe("1000");
    expect(
      screen
        .getByRole("progressbar", { name: "Max latency: 250 ms" })
        .getAttribute("aria-valuemax"),
    ).toBe("1000");
    expect(
      screen
        .getByRole("progressbar", { name: "Active: 2" })
        .getAttribute("aria-valuemax"),
    ).toBe("10");
  });

  test("storage series align by date and retain missing samples instead of invented zero values", () => {
    useQueryMock.mockReturnValue({
      data: {
        admin: {
          adminDashboard: {
            ...dashboardData.admin.adminDashboard,
            workspaceStorageHistory: [{ date: "2026-02-14", value: 0 }],
            blobStorageHistory: [{ date: "2026-02-15", value: 1024 }],
          },
        },
      },
      isValidating: false,
    });
    renderDashboard();
    const points = JSON.parse(
      screen.getAllByTestId("composed-chart")[1].getAttribute("data-points")!,
    );
    expect(points).toEqual([
      { label: "2/14/2026", primary: 0, x: 0 },
      { label: "2/15/2026", secondary: 1024, x: 1 },
    ]);
  });
});
