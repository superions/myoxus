// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { DatabaseProfileKind } from "@myoxus/graphql";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { useDatabasePage } from "./use-database-page";

const gql = vi.fn();
const graphqlService = { gql };

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: () => graphqlService,
}));

function Probe() {
  const { record } = useDatabasePage("workspace-1", "database-1");
  return (
    <output data-testid="database-state">
      {record === undefined ? "loading" : (record?.title ?? "missing")}
    </output>
  );
}

beforeEach(() => {
  gql.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useDatabasePage", () => {
  test("hides inaccessible or stale organizer targets without logging a render error", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    gql.mockRejectedValueOnce(new Error("not found or forbidden"));

    render(<Probe />);

    await waitFor(() =>
      expect(screen.getByTestId("database-state").textContent).toBe("missing"),
    );
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("does not poison the StrictMode replacement request through shared transport cancellation", async () => {
    let rejectShared: (reason?: unknown) => void = (_reason?: unknown) =>
      undefined;
    const sharedRequest = new Promise<{
      workspace: {
        databaseSummary: {
          createdAt: string;
          deletedAt: null;
          description: string;
          editRevision: number;
          fieldCount: number;
          id: string;
          profileKind: DatabaseProfileKind;
          systemRole: null;
          rowCount: number;
          title: string;
          updatedAt: string;
          viewCount: number;
        };
      };
    }>((resolve, reject) => {
      rejectShared = reject;
      setTimeout(
        () =>
          resolve({
            workspace: {
              databaseSummary: {
                createdAt: "2026-07-15T06:00:00Z",
                deletedAt: null,
                description: "Visible organizer page",
                editRevision: 1,
                fieldCount: 4,
                id: "database-1",
                profileKind: DatabaseProfileKind.Project,
                systemRole: null,
                rowCount: 8,
                title: "StrictMode project",
                updatedAt: "2026-07-15T06:00:00Z",
                viewCount: 2,
              },
            },
          }),
        0,
      );
    });

    gql.mockImplementation(
      ({ context }: { context?: { signal?: AbortSignal } }) => {
        context?.signal?.addEventListener("abort", () =>
          rejectShared(new DOMException("Aborted", "AbortError")),
        );
        return sharedRequest;
      },
    );

    render(
      <StrictMode>
        <Probe />
      </StrictMode>,
    );

    await waitFor(() =>
      expect(screen.getByTestId("database-state").textContent).toBe(
        "StrictMode project",
      ),
    );
    expect(gql).toHaveBeenCalledTimes(2);
    expect(gql.mock.calls.every(([options]) => !options.context?.signal)).toBe(
      true,
    );
  });
});
