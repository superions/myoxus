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

const mockRevalidateJobs = vi.fn().mockResolvedValue(undefined);
const mockJobsState: { jobs: any[] } = { jobs: [] };

vi.mock("./api", () => ({
  useTemplateJobsQuery: () => ({
    jobs: mockJobsState.jobs,
  }),
  useTemplateRegistryRevalidate: () => ({
    revalidateJobs: mockRevalidateJobs,
  }),
}));

import { JobsTab } from "./jobs-tab";

function renderWithFacade(ui: ReactElement) {
  return render(<MyoxusUIProvider>{ui}</MyoxusUIProvider>);
}

describe("JobsTab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockJobsState.jobs = [
      {
        id: "job-1",
        jobType: "IMPORT",
        state: "COMPLETED",
        templateId: "template-12345678",
        workspaceId: "workspace-87654321",
        startedAt: "2026-01-01T10:00:00Z",
        finishedAt: "2026-01-01T10:01:00Z",
      },
    ];
  });

  afterEach(() => {
    cleanup();
  });

  test("refresh button triggers job revalidation", async () => {
    renderWithFacade(<JobsTab />);
    fireEvent.click(screen.getByText("Refresh"));
    await waitFor(() => {
      expect(mockRevalidateJobs).toHaveBeenCalledTimes(1);
    });
  });
});
