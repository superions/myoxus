/** @vitest-environment happy-dom */
import { WorkspaceQuotaSource } from "@myoxus/graphql";
import { MyoxusUIProvider } from "@myoxus/ui-facade/provider";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// ─── Mock external dependencies ──────────────────────────────────────────────

const useQueryMock = vi.fn();
vi.mock("../../../use-query", () => ({
  useQuery: (key: unknown, opts: unknown) => useQueryMock(key, opts),
}));

// ─── Import under test (after mocks) ─────────────────────────────────────────

import { WorkspaceQuotaInspector } from "./workspace-quota-inspector";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const GB = 1024 * 1024 * 1024;

function makeDetails(
  source: string,
  overrides?: {
    workspaceOverrideBytes?: number | null;
    configDefaultMb?: number;
    effectiveBytes?: number;
    usedBytes?: number;
  },
) {
  return {
    source,
    workspaceOverrideBytes: overrides?.workspaceOverrideBytes ?? null,
    configDefaultMb: overrides?.configDefaultMb ?? 10240,
    effectiveBytes: overrides?.effectiveBytes ?? 10 * GB,
    usedBytes: overrides?.usedBytes ?? 2 * GB,
  };
}

function renderInspector(details: ReturnType<typeof makeDetails> | null) {
  useQueryMock.mockReturnValue(
    details
      ? {
          data: { admin: { adminWorkspaceQuotaDetails: details } },
          isLoading: false,
        }
      : { data: undefined, isLoading: true },
  );
  return render(
    <MyoxusUIProvider>
      <WorkspaceQuotaInspector workspaceId="ws-test" />
    </MyoxusUIProvider>,
  );
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  useQueryMock.mockReturnValue({ data: undefined, isLoading: false });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkspaceQuotaInspector", () => {
  test("inv_inspector_highlights_active_source — only active row has active badge", () => {
    renderInspector(
      makeDetails(WorkspaceQuotaSource.WorkspaceOverride, {
        workspaceOverrideBytes: 5 * GB,
        effectiveBytes: 5 * GB,
      }),
    );

    // Find all table rows
    const rows = screen.getAllByRole("row");
    // Skip header row (index 0)
    const dataRows = rows.slice(1);

    expect(within(dataRows[0]).queryByText("Active")).not.toBeNull();
    expect(within(dataRows[1]).queryByText("Active")).toBeNull();
    expect(within(dataRows[2]).queryByText("Active")).toBeNull();
  });

  test("inv_inspector_usage_progressbar — progress bar shown for finite quotas", () => {
    renderInspector(
      makeDetails(WorkspaceQuotaSource.ConfigDefault, {
        configDefaultMb: 10240,
        effectiveBytes: 10 * GB,
        usedBytes: 5 * GB,
      }),
    );

    const progressBar = screen.getByRole("progressbar", {
      name: /5(\.0)? GiB.*10(\.0)? GiB|5(\.0)? GB.*10(\.0)? GB/i,
    });
    expect(progressBar.getAttribute("aria-valuenow")).toBe("50");
  });

  test("inv_inspector_no_progressbar_unlimited — no progress bar for unlimited", () => {
    renderInspector(
      makeDetails(WorkspaceQuotaSource.Unlimited, {
        configDefaultMb: 0,
        effectiveBytes: 0,
        usedBytes: 0,
      }),
    );

    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});
