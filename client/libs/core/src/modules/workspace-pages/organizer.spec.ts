// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, test, vi } from "vitest";

import type { FolderNode } from "../organize";
import {
  collectWorkspaceFolderOptions,
  linkDatabasePageToFolder,
} from "./organizer";

type TestNode = FolderNode & {
  testChildren: TestNode[];
  delete: ReturnType<typeof vi.fn>;
  createLink: ReturnType<typeof vi.fn>;
  moveHere: ReturnType<typeof vi.fn>;
};

function node({
  id,
  type,
  data,
  parentId = null,
  children = [],
}: {
  id: string | null;
  type: string;
  data: string;
  parentId?: string | null;
  children?: TestNode[];
}): TestNode {
  const testNode = {
    id,
    testChildren: children,
    type$: { value: type },
    data$: { value: data },
    name$: { value: type === "folder" ? data : "" },
    info$: { value: id ? { id, type, data, parentId, index: "a" } : null },
    sortedChildren$: { value: children },
    delete: vi.fn(),
    createLink: vi.fn(),
    moveHere: vi.fn(),
    indexAt: vi.fn(() => "z"),
  };
  return testNode as unknown as TestNode;
}

describe("Database Page organizer projection", () => {
  test("flattens the live folder hierarchy without exposing link nodes", () => {
    const nested = node({ id: "nested", type: "folder", data: "Nested" });
    const rootFolder = node({
      id: "folder-1",
      type: "folder",
      data: "Planning",
      children: [
        nested,
        node({ id: "link-1", type: "database", data: "database-1" }),
      ],
    });
    const root = node({
      id: null,
      type: "folder",
      data: "",
      children: [rootFolder],
    });

    expect(collectWorkspaceFolderOptions(root)).toEqual([
      { value: "folder-1", label: "Planning" },
      { value: "nested", label: "Planning / Nested" },
    ]);
  });

  test("keeps one target link, removes duplicates and performs no move", () => {
    const kept = node({
      id: "link-target",
      type: "database",
      data: "database-1",
      parentId: "folder-target",
    });
    const duplicate = node({
      id: "link-duplicate",
      type: "database",
      data: "database-1",
      parentId: "folder-other",
    });
    const target = node({
      id: "folder-target",
      type: "folder",
      data: "Target",
      children: [kept],
    });
    const other = node({
      id: "folder-other",
      type: "folder",
      data: "Other",
      children: [duplicate],
    });
    const root = node({
      id: null,
      type: "folder",
      data: "",
      children: [target, other],
    });

    linkDatabasePageToFolder(root, "database-1", "folder-target");

    expect(target.moveHere).not.toHaveBeenCalled();
    expect(target.createLink).not.toHaveBeenCalled();
    expect(kept.delete).not.toHaveBeenCalled();
    expect(duplicate.delete).toHaveBeenCalledOnce();
  });

  test("creates the missing link and rejects an unavailable target", () => {
    const target = node({
      id: "folder-target",
      type: "folder",
      data: "Target",
    });
    const root = node({
      id: null,
      type: "folder",
      data: "",
      children: [target],
    });

    linkDatabasePageToFolder(root, "database-1", "folder-target");
    expect(target.createLink).toHaveBeenCalledWith(
      "database",
      "database-1",
      "z",
    );
    expect(() =>
      linkDatabasePageToFolder(root, "database-1", "missing-folder"),
    ).toThrow("Folder not found");
  });

  test("moves one existing link, removes duplicates and unlinks cleanly", () => {
    const primary = node({
      id: "link-primary",
      type: "database",
      data: "database-1",
      parentId: "folder-source",
    });
    const duplicate = node({
      id: "link-duplicate",
      type: "database",
      data: "database-1",
      parentId: "folder-source",
    });
    const source = node({
      id: "folder-source",
      type: "folder",
      data: "Source",
      children: [primary, duplicate],
    });
    const target = node({
      id: "folder-target",
      type: "folder",
      data: "Target",
    });
    const root = node({
      id: null,
      type: "folder",
      data: "",
      children: [source, target],
    });

    linkDatabasePageToFolder(root, "database-1", "folder-target");
    expect(target.moveHere).toHaveBeenCalledWith("link-primary", "z");
    expect(duplicate.delete).toHaveBeenCalledOnce();

    linkDatabasePageToFolder(root, "database-1", null);
    expect(primary.delete).toHaveBeenCalledOnce();
    expect(duplicate.delete).toHaveBeenCalledTimes(2);
  });

  test("terminates safely when a malformed folder graph contains a cycle", () => {
    const nested = node({ id: "nested", type: "folder", data: "Nested" });
    const root = node({
      id: null,
      type: "folder",
      data: "",
      children: [nested],
    });
    nested.testChildren.push(root);

    expect(collectWorkspaceFolderOptions(root)).toEqual([
      { value: "nested", label: "Nested" },
    ]);
    expect(() =>
      linkDatabasePageToFolder(root, "database-1", "missing"),
    ).toThrow("Folder not found");
  });
});
