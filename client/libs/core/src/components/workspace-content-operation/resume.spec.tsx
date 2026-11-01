// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * @vitest-environment happy-dom
 */

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

import { WorkspaceContentOperationResume } from "./resume";

const open = vi.hoisted(() => vi.fn());

vi.mock("@myoxus/infra", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@myoxus/infra")>();
  return {
    ...actual,
    useService: () => ({ open }),
  };
});

describe("WorkspaceContentOperationResume", () => {
  afterEach(() => {
    open.mockReset();
    window.history.replaceState(null, "", "/");
  });

  test("reopens a valid durable operation once from the workspace URL", async () => {
    const operationId = "eaa58d61-c353-5b4e-8765-de6167577211";
    window.history.replaceState(
      null,
      "",
      `/workspace/source/all?workspaceContentOperation=${operationId}`,
    );

    const view = render(<WorkspaceContentOperationResume />);
    view.rerender(<WorkspaceContentOperationResume />);

    await waitFor(() => {
      expect(open).toHaveBeenCalledOnce();
      expect(open).toHaveBeenCalledWith("workspace-content-operation", {
        resumeOperationId: operationId,
      });
    });
  });

  test("does not open a dialog for an invalid operation identifier", () => {
    window.history.replaceState(
      null,
      "",
      "/workspace/source/all?workspaceContentOperation=not-an-operation",
    );

    render(<WorkspaceContentOperationResume />);

    expect(open).not.toHaveBeenCalled();
  });
});
