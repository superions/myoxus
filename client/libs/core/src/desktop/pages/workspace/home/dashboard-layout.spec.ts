// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  DASHBOARD_DASHLET_IDS,
  getDashboardDocumentLimit,
  moveDashboardDashlet,
  resizeDashboardDashlet,
  resolveWorkspaceDashboardLayout,
  toWorkspaceDashboardLayout,
} from "./dashboard-layout";

describe("workspace dashboard layout", () => {
  test("resolves every fixed dashlet once and appends missing product defaults", () => {
    const resolved = resolveWorkspaceDashboardLayout({
      workspaceId: "workspace",
      orderedDashletIds: ["activity", "today", "activity"],
      dashletSizes: { activity: "wide", "new-documents": "compact" },
    });

    expect(resolved.orderedDashletIds).toEqual([
      "activity",
      "today",
      "new-documents",
      "reminders",
      "recently-edited",
      "tasks",
    ]);
    expect(new Set(resolved.orderedDashletIds)).toEqual(
      new Set(DASHBOARD_DASHLET_IDS),
    );
    expect(resolved.dashletSizes.activity).toBe("wide");
    expect(resolved.dashletSizes.today).toBe("wide");
    expect(resolved.dashletSizes["new-documents"]).toBe("compact");
  });

  test("keeps an old complete saved arrangement and appends Tasks without writing defaults", () => {
    const saved = {
      workspaceId: "workspace",
      orderedDashletIds: [
        "activity",
        "reminders",
        "today",
        "recently-edited",
        "new-documents",
      ] as const,
      dashletSizes: { activity: "wide", "recently-edited": "compact" } as const,
    };
    const before = structuredClone(saved);
    const resolved = resolveWorkspaceDashboardLayout(saved);
    expect(resolved.orderedDashletIds).toEqual([
      ...saved.orderedDashletIds,
      "tasks",
    ]);
    expect(resolved.dashletSizes.tasks).toBe("standard");
    expect(resolved.dashletSizes.activity).toBe("wide");
    expect(resolved.dashletSizes["recently-edited"]).toBe("compact");
    expect(saved).toEqual(before);
    expect(
      resolveWorkspaceDashboardLayout(null).orderedDashletIds.slice(0, 2),
    ).toEqual(["today", "tasks"]);
  });

  test("moves within bounds and permits only supported compact dashlets", () => {
    const initial = resolveWorkspaceDashboardLayout(null);
    const moved = moveDashboardDashlet(initial, "activity", 1);
    expect(moved.orderedDashletIds).toEqual([
      "today",
      "activity",
      "tasks",
      "new-documents",
      "reminders",
      "recently-edited",
    ]);
    expect(
      moveDashboardDashlet(moved, "today", Number.POSITIVE_INFINITY)
        .orderedDashletIds,
    ).toEqual([
      "activity",
      "tasks",
      "new-documents",
      "reminders",
      "recently-edited",
      "today",
    ]);
    expect(
      resizeDashboardDashlet(moved, "new-documents", "compact"),
    ).toMatchObject({
      dashletSizes: { "new-documents": "compact" },
    });
    expect(resizeDashboardDashlet(moved, "today", "compact")).toBe(moved);
    expect(resizeDashboardDashlet(moved, "tasks", "compact")).toBe(moved);
    expect(resizeDashboardDashlet(moved, "reminders", "compact")).toBe(moved);
    expect(resizeDashboardDashlet(moved, "activity", "compact")).toBe(moved);
    expect(resizeDashboardDashlet(moved, "activity", "wide")).toMatchObject({
      dashletSizes: { activity: "wide" },
    });
  });

  test("projects document density from semantic size", () => {
    expect(getDashboardDocumentLimit("compact")).toBe(3);
    expect(getDashboardDocumentLimit("standard")).toBe(4);
    expect(getDashboardDocumentLimit("wide")).toBe(6);
  });

  test("materializes the resolved state only for an explicit user action", () => {
    const resolved = resolveWorkspaceDashboardLayout(null);
    expect(toWorkspaceDashboardLayout("workspace", resolved)).toEqual({
      workspaceId: "workspace",
      orderedDashletIds: DASHBOARD_DASHLET_IDS,
      dashletSizes: {
        today: "wide",
        tasks: "standard",
        "new-documents": "standard",
        reminders: "standard",
        "recently-edited": "standard",
        activity: "standard",
      },
    });
  });
});
