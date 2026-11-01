// SPDX-License-Identifier: AGPL-3.0-or-later

import { DatabaseProfileKind } from "@myoxus/graphql";
import { describe, expect, test } from "vitest";

import type { DatabasePageRecord } from "./database-pages";
import { composeWorkspacePageGroups } from "./projection";

const databases: DatabasePageRecord[] = [
  {
    createdAt: "2026-07-01T08:00:00.000Z",
    description: "Alpha overview",
    editRevision: 1,
    id: "shared-id",
    key: "database:shared-id",
    profileKind: DatabaseProfileKind.Generic,
    title: "Alpha database",
    updatedAt: "2026-07-03T08:00:00.000Z",
  },
  {
    createdAt: "2026-07-02T08:00:00.000Z",
    description: "Project overview",
    editRevision: 2,
    id: "database-2",
    key: "database:database-2",
    profileKind: DatabaseProfileKind.Project,
    title: "Zeta project",
    updatedAt: "2026-07-04T08:00:00.000Z",
  },
];

const documentMetadata = new Map([
  [
    "shared-id",
    {
      createdAt: new Date("2026-07-01T07:00:00.000Z").valueOf(),
      id: "shared-id",
      title: "Alpha document",
      updatedAt: new Date("2026-07-02T07:00:00.000Z").valueOf(),
    },
  ],
  [
    "document-2",
    {
      createdAt: new Date("2026-07-03T07:00:00.000Z").valueOf(),
      id: "document-2",
      title: "Beta document",
      updatedAt: new Date("2026-07-05T07:00:00.000Z").valueOf(),
    },
  ],
]);

describe("mixed Workspace Page projection", () => {
  test("renders two documents and two Databases with overlapping raw IDs", () => {
    const [group] = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [{ key: "", items: ["shared-id", "document-2"] }],
      documentMetadata,
      filters: [],
    });

    expect(group?.items).toEqual([
      "document:shared-id",
      "document:document-2",
      "database:shared-id",
      "database:database-2",
    ]);
    expect(new Set(group?.items).size).toBe(4);
  });

  test("applies common title, favorite and Page-kind filters to both kinds", () => {
    const title = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      // CollectionRules already reduced the document half using the same title.
      documentGroups: [{ key: "", items: ["shared-id"] }],
      documentMetadata,
      filters: [
        { type: "system", key: "title", method: "match", value: "alpha" },
      ],
    });
    expect(title[0]?.items).toEqual([
      "document:shared-id",
      "database:shared-id",
    ]);

    const favorites = composeWorkspacePageGroups({
      databaseFavorites: new Set(["database-2"]),
      databases,
      documentGroups: [{ key: "", items: ["document-2"] }],
      documentMetadata,
      filters: [
        { type: "system", key: "favorite", method: "is", value: "true" },
      ],
    });
    expect(favorites[0]?.items).toEqual([
      "document:document-2",
      "database:database-2",
    ]);

    const databasesOnly = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [],
      documentMetadata,
      filters: [
        { type: "system", key: "pageKind", method: "is", value: "database" },
      ],
    });
    expect(databasesOnly[0]?.items).toEqual([
      "database:shared-id",
      "database:database-2",
    ]);
  });

  test("excludes Databases for document-only filters, grouping and ordering", () => {
    const filtered = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [{ key: "", items: ["shared-id"] }],
      documentMetadata,
      filters: [
        { type: "system", key: "tags", method: "include", value: "tag-1" },
      ],
    });
    expect(filtered[0]?.items).toEqual(["document:shared-id"]);

    const grouped = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [{ key: "tag-1", items: ["shared-id"] }],
      documentMetadata,
      filters: [],
      groupBy: { type: "system", key: "tags" },
    });
    expect(grouped).toEqual([{ key: "tag-1", items: ["document:shared-id"] }]);
  });

  test("sorts and date-groups both kinds using Database ISO metadata", () => {
    const dateFiltered = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [],
      documentMetadata,
      filters: [
        {
          type: "system",
          key: "createdAt",
          method: "after",
          value: "2026-07-02",
        },
      ],
    });
    expect(dateFiltered[0]?.items).toEqual(["database:database-2"]);

    const sorted = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [{ key: "", items: ["shared-id", "document-2"] }],
      documentMetadata,
      filters: [],
      orderBy: { type: "system", key: "updatedAt", desc: true },
    });
    expect(sorted[0]?.items).toEqual([
      "document:document-2",
      "database:database-2",
      "database:shared-id",
      "document:shared-id",
    ]);

    const grouped = composeWorkspacePageGroups({
      databaseFavorites: new Set(),
      databases,
      documentGroups: [
        { key: "2026-07-01", items: ["shared-id"] },
        { key: "2026-07-03", items: ["document-2"] },
      ],
      documentMetadata,
      filters: [],
      groupBy: { type: "system", key: "createdAt" },
      orderBy: { type: "system", key: "updatedAt", desc: true },
    });
    expect(grouped).toEqual([
      { key: "2026-07-03", items: ["document:document-2"] },
      { key: "2026-07-02", items: ["database:database-2"] },
      {
        key: "2026-07-01",
        items: ["database:shared-id", "document:shared-id"],
      },
    ]);
  });
});
