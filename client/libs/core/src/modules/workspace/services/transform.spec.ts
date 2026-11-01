// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { Framework } from "@myoxus/infra";
import { Doc as YDoc, encodeStateAsUpdate } from "yjs";
import { afterEach, expect, test, vi } from "vitest";

import { transformWorkspaceDBLocalToCloud } from "../../db/utils";
import type { Workspace as WorkspaceEntity } from "../entities/workspace";
import type { DocImpl } from "../impls/doc";
import { WorkspaceImpl } from "../impls/workspace";
import { WorkspaceDestroyService } from "./destroy";
import { WorkspaceFactoryService } from "./factory";
import { WorkspaceTransformService } from "./transform";

vi.mock("../../db/utils", () => ({
  transformWorkspaceDBLocalToCloud: vi.fn(async () => {}),
}));

const collections: WorkspaceImpl[] = [];

afterEach(() => {
  for (const collection of collections.splice(0)) collection.dispose();
});

test("native transformation includes every unopened document descriptor", async () => {
  const sourceCollection = new WorkspaceImpl({
    id: "source-workspace",
    rootDoc: new YDoc({ guid: "source-workspace" }),
  });
  collections.push(sourceCollection);
  sourceCollection.meta.initialize();
  const leafUpdates = new Map<string, Uint8Array>();
  for (const id of ["first", "second", "third"]) {
    sourceCollection.meta.addDocMeta({
      id,
      title: id,
      createDate: 1,
      tags: [],
    });
    const leaf = new YDoc({ guid: id });
    leaf.getText("content").insert(0, `${id} content`);
    leafUpdates.set(id, encodeStateAsUpdate(leaf));
    leaf.destroy();
  }
  const sourceDescriptors = [...sourceCollection.docs.values()] as DocImpl[];
  expect(sourceDescriptors.every((doc) => !doc.runtimeInitialized)).toBe(true);

  const getDoc = vi.fn(async (id: string) => {
    const bin =
      id === sourceCollection.doc.guid
        ? encodeStateAsUpdate(sourceCollection.doc)
        : leafUpdates.get(id);
    return bin ? { bin } : null;
  });
  const source = {
    id: "source-workspace",
    flavour: "local",
    meta: { id: "source-workspace", flavour: "local" },
    docCollection: sourceCollection,
    engine: {
      doc: { storage: { getDoc } },
      blob: { storage: { list: async () => [], get: async () => null } },
    },
  } as unknown as WorkspaceEntity;

  let targetCollection: WorkspaceImpl | undefined;
  const factory = {
    create: vi.fn(async (_flavour, initial) => {
      targetCollection = new WorkspaceImpl({
        id: "target-workspace",
        rootDoc: new YDoc({ guid: "target-workspace" }),
      });
      collections.push(targetCollection);
      await initial(targetCollection, { set: vi.fn() }, {});
      return { id: "target-workspace", flavour: "selfhosted" };
    }),
  } as unknown as WorkspaceFactoryService;
  const destroy = {
    deleteWorkspace: vi.fn(async () => true),
  } as unknown as WorkspaceDestroyService;
  const framework = new Framework();
  framework
    .service(WorkspaceFactoryService, factory)
    .service(WorkspaceDestroyService, destroy)
    .service(WorkspaceTransformService, [
      WorkspaceFactoryService,
      WorkspaceDestroyService,
    ]);

  const result = await framework
    .provider()
    .get(WorkspaceTransformService)
    .transformLocalToCloud(source, "account-1", "selfhosted");

  expect(result.id).toBe("target-workspace");
  expect(getDoc.mock.calls.map(([id]) => id)).toEqual([
    "source-workspace",
    "first",
    "second",
    "third",
  ]);
  expect(sourceDescriptors.every((doc) => !doc.runtimeInitialized)).toBe(true);
  expect([...targetCollection!.docs.keys()]).toEqual([
    "first",
    "second",
    "third",
  ]);
  for (const id of ["first", "second", "third"]) {
    expect(
      targetCollection!.getDoc(id)?.spaceDoc.getText("content").toString(),
    ).toBe(`${id} content`);
  }
  expect(transformWorkspaceDBLocalToCloud).toHaveBeenCalledOnce();
  expect(destroy.deleteWorkspace).toHaveBeenCalledWith(source.meta);
});
