// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, test } from "vitest";

import {
  cancelWorkspaceContentOperationMutation,
  executeWorkspaceContentOperationMutation,
  retryWorkspaceContentOperationMutation,
  undoWorkspaceContentOperationMutation,
  workspaceContentOperationQuery,
  workspaceContentPreflightMutation,
  workspaceContentRedirectQuery,
} from "../graphql/index.js";

describe("workspace content operation codegen contract", () => {
  test("exports every actor operation required by the XWS control flow", () => {
    const operations = [
      {
        operation: workspaceContentPreflightMutation,
        rootField: "workspaceContentPreflight",
      },
      {
        operation: executeWorkspaceContentOperationMutation,
        rootField: "executeWorkspaceContentOperation",
      },
      {
        operation: workspaceContentOperationQuery,
        rootField: "workspaceContentOperation",
      },
      {
        operation: cancelWorkspaceContentOperationMutation,
        rootField: "cancelWorkspaceContentOperation",
      },
      {
        operation: retryWorkspaceContentOperationMutation,
        rootField: "retryWorkspaceContentOperation",
      },
      {
        operation: undoWorkspaceContentOperationMutation,
        rootField: "undoWorkspaceContentOperation",
      },
    ];

    for (const { operation, rootField } of operations) {
      expect(operation).toMatchObject({ op: rootField });
      expect(operation.query).toContain("WorkspaceContentOperationProjection");
    }
    expect(workspaceContentPreflightMutation.query).toContain(
      "WorkspaceContentPreflightProjection",
    );
    expect(undoWorkspaceContentOperationMutation.query).toContain(
      "WorkspaceContentPreflightProjection",
    );
    expect(workspaceContentRedirectQuery).toMatchObject({
      op: "workspaceContentRedirect",
    });
    expect(workspaceContentRedirectQuery.query).toContain(
      "query workspaceContentRedirect",
    );
    expect(workspaceContentRedirectQuery.query).toContain("workspaceId");
    expect(workspaceContentRedirectQuery.query).toContain("kind");
    expect(workspaceContentRedirectQuery.query).toContain("id");
  });
});
