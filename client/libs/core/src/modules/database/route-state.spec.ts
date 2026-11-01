// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  classifyDatabaseError,
  databaseRoute,
  getDatabaseDetailRouteStatus,
  getDatabaseIndexRouteStatus,
  getDatabaseUnavailableWorkspaceRouteStatus,
} from "./route-state";

describe("database route state", () => {
  test("delegates default-View selection when creation omits a view id", () => {
    expect(databaseRoute("database-created")).toBe(
      "/databases/database-created",
    );
    expect(databaseRoute("database-created", null)).toBe(
      "/databases/database-created",
    );
    expect(databaseRoute("database-created", "view-table")).toBe(
      "/databases/database-created?viewId=view-table",
    );
  });

  test("classifies stable server error codes before rendering generic route fallbacks", () => {
    expect(
      classifyDatabaseError({
        extensions: { code: "MIX_DATABASE_FORBIDDEN" },
      }),
    ).toBe("forbidden");
    expect(
      classifyDatabaseError(
        new Error("server returned MIX_DATABASE_NOT_FOUND"),
      ),
    ).toBe("missing");
    expect(classifyDatabaseError(new Error("network failed"))).toBe(
      "unavailable",
    );
  });

  test("index route separates loading, unavailable workspace and ready data", () => {
    expect(
      getDatabaseIndexRouteStatus({
        dataLoaded: false,
        hasWorkspace: false,
        isLoading: true,
      }),
    ).toBe("loading");
    expect(
      getDatabaseIndexRouteStatus({
        dataLoaded: true,
        hasWorkspace: false,
      }),
    ).toBe("unavailable");
    expect(
      getDatabaseIndexRouteStatus({
        dataLoaded: true,
        hasWorkspace: true,
      }),
    ).toBe("ready");
  });

  test("maps local workspaces to an explicit server-backed-only route state before GraphQL can run", () => {
    expect(
      getDatabaseUnavailableWorkspaceRouteStatus({
        reason: "local-workspace",
      }),
    ).toBe("local-unavailable");
    expect(
      getDatabaseUnavailableWorkspaceRouteStatus({
        reason: "missing-server-binding",
      }),
    ).toBe("unavailable");
  });

  test("detail route does not collapse deleted, forbidden and invalid data into one missing state", () => {
    expect(
      getDatabaseDetailRouteStatus({
        databaseDataLoaded: true,
        databaseError: { extensions: { code: "MIX_DATABASE_FORBIDDEN" } },
        hasActiveView: false,
        hasDatabase: false,
        hasRowsConnection: false,
        hasWorkspace: false,
        rowDataLoaded: true,
      }),
    ).toBe("forbidden");
    expect(
      getDatabaseDetailRouteStatus({
        databaseDataLoaded: true,
        hasActiveView: false,
        hasDatabase: false,
        hasRowsConnection: true,
        hasWorkspace: true,
        rowDataLoaded: true,
      }),
    ).toBe("missing");
    expect(
      getDatabaseDetailRouteStatus({
        databaseDataLoaded: true,
        hasActiveView: false,
        hasDatabase: true,
        hasRowsConnection: true,
        hasWorkspace: true,
        rowDataLoaded: true,
      }),
    ).toBe("unavailable");
    expect(
      getDatabaseDetailRouteStatus({
        databaseDataLoaded: true,
        hasActiveView: true,
        hasDatabase: true,
        hasRowsConnection: true,
        hasWorkspace: true,
        rowDataLoaded: true,
      }),
    ).toBe("ready");
  });
});
