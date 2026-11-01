// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import type { WorkbenchToolLayout } from "../../../server/stores/user-preferences";
import { moveVisibleTool, resolveWorkbenchToolLayout } from "../tool-layout";

const override = (
  values: Partial<WorkbenchToolLayout>,
): WorkbenchToolLayout => ({
  workspaceId: "workspace-a",
  viewFamily: "document-page",
  orderedToolIds: [],
  visibleToolIds: [],
  collapsedToolIds: [],
  ...values,
});

describe("workbench tool layout resolver", () => {
  test.each([
    [
      "document-page",
      ["outline", "tags", "document-info"],
      ["outline", "tags"],
    ],
    ["document-edgeless", ["frame", "document-info"], ["frame"]],
    ["journal", ["calendar", "agenda"], ["calendar"]],
    ["database", ["database-settings"], ["database-settings"]],
    ["graph", [], []],
    ["graph", ["graph-details"], ["graph-details"]],
  ] as const)(
    "materializes the %s default only from available capabilities",
    (viewFamily, registeredToolIds, visibleToolIds) => {
      expect(
        resolveWorkbenchToolLayout({
          viewFamily,
          registeredToolIds,
          override: null,
        }),
      ).toEqual({
        orderedToolIds: registeredToolIds,
        visibleToolIds,
        collapsedToolIds: [],
      });
    },
  );

  test("preserves an explicit empty override and appends new capabilities hidden", () => {
    expect(
      resolveWorkbenchToolLayout({
        viewFamily: "document-page",
        registeredToolIds: ["outline", "activity"],
        override: override({
          orderedToolIds: ["outline"],
          visibleToolIds: [],
        }),
      }),
    ).toEqual({
      orderedToolIds: ["outline", "activity"],
      visibleToolIds: [],
      collapsedToolIds: [],
    });
  });

  test("appends Tags hidden when resolving an explicit layout from before Tags existed", () => {
    expect(
      resolveWorkbenchToolLayout({
        viewFamily: "document-page",
        registeredToolIds: ["outline", "tags", "document-info"],
        override: override({
          orderedToolIds: ["outline", "document-info"],
          visibleToolIds: ["outline"],
        }),
      }),
    ).toEqual({
      orderedToolIds: ["outline", "document-info", "tags"],
      visibleToolIds: ["outline"],
      collapsedToolIds: [],
    });
  });

  test("retains unavailable ordered tools and repairs subset violations", () => {
    expect(
      resolveWorkbenchToolLayout({
        viewFamily: "document-page",
        registeredToolIds: ["outline", "activity"],
        override: override({
          orderedToolIds: ["comment", "outline"],
          visibleToolIds: ["comment", "outline", "chat"],
          collapsedToolIds: ["outline", "chat", "activity"],
        }),
      }),
    ).toEqual({
      orderedToolIds: ["comment", "outline", "activity"],
      visibleToolIds: ["comment", "outline"],
      collapsedToolIds: ["outline"],
    });
  });

  test("reorders visible tools without moving hidden slots", () => {
    expect(
      moveVisibleTool(
        {
          orderedToolIds: ["outline", "document-info", "activity", "comment"],
          visibleToolIds: ["outline", "activity", "comment"],
          collapsedToolIds: ["activity"],
        },
        "comment",
        0,
      ),
    ).toEqual({
      orderedToolIds: ["comment", "document-info", "outline", "activity"],
      visibleToolIds: ["comment", "outline", "activity"],
      collapsedToolIds: ["activity"],
    });
  });
});
