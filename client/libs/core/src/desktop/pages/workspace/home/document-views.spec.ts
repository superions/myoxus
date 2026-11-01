// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test } from "vitest";

import {
  type DashboardDocument,
  projectDashboardDocuments,
} from "./document-views";

const document = (
  id: string,
  overrides: Partial<DashboardDocument> = {},
): DashboardDocument => ({
  createDate: 100,
  id,
  mode: "page",
  title: id,
  trash: false,
  updatedDate: 100,
  ...overrides,
});

describe("Workspace Home document projections", () => {
  test("keeps creation and edit projections independent with stable ties", () => {
    const result = projectDashboardDocuments([
      document("b", { createDate: 300, updatedDate: 100 }),
      document("a", { createDate: 300, updatedDate: 200 }),
      document("c", { createDate: 100, updatedDate: 400 }),
    ]);

    expect(result.newDocuments.map(({ id }) => id)).toEqual(["a", "b", "c"]);
    expect(result.recentlyEdited.map(({ id }) => id)).toEqual(["c", "a", "b"]);
  });

  test("excludes trash and empty journals without dropping populated journals", () => {
    const result = projectDashboardDocuments([
      document("trash", { trash: true }),
      document("empty-journal", {
        journalDate: "2026-07-27",
        updatedDate: undefined,
      }),
      document("populated-journal", { journalDate: "2026-07-26" }),
      document("untitled", { title: "" }),
    ]);

    expect(result.newDocuments.map(({ id }) => id)).toEqual([
      "populated-journal",
      "untitled",
    ]);
    expect(result.recentlyEdited.map(({ id }) => id)).toEqual([
      "populated-journal",
      "untitled",
    ]);
  });

  test("caps each projection independently", () => {
    const documents = Array.from({ length: 8 }, (_, index) =>
      document(String(index), {
        createDate: index,
        updatedDate: 8 - index,
      }),
    );

    const result = projectDashboardDocuments(documents, 3);
    expect(result.newDocuments).toHaveLength(3);
    expect(result.recentlyEdited).toHaveLength(3);
  });
});
