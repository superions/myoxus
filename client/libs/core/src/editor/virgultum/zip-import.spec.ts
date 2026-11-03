/** @vitest-environment happy-dom */
import * as Y from "yjs";
import { exportWorkspaceLabels } from "../../modules/tag/export";
import { createHash } from "node:crypto";

import { StoreExtensionManager } from "@virgultum/editor/ext-loader";
import { getInternalStoreExtensions } from "@virgultum/editor/extensions/store";
import type {
  ImageBlockModel,
  ParagraphBlockModel,
} from "@virgultum/editor/model";
import { MyoxusSchemas } from "@virgultum/editor/schemas";
import { snapshotLabelImportHooks } from "../../desktop/dialogs/import/import-labels";
import type { Workspace } from "../../modules/workspace";
import type { DocsService } from "../../modules/doc";
import type { GraphQLService } from "../../modules/server";
import { createZipFixture, readZipFixture } from "../../__tests__/zip-fixture";
import {
  MarkdownTransformer,
  ZipTransformer,
} from "@virgultum/editor/widgets/linked-doc";
import { Schema } from "@virgultum/store";
import { TestWorkspace } from "@virgultum/store/test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

// These bytes also exercise the product's Markdown-with-media file import.
const validZip =
  "UEsDBBQAAAAIAAAAIVAeT/DYhwAAAKMAAAAUAAAAbmVzdGVkL2NoZWNrcG9pbnQubWQdjsEKwjAQBe/7FSu92FDqP4gXL+LZ0kOaPDU0bEKylfr31l6HYZiGL8gQD3FfzrZUFHZvuDmnIEp0Q1V4trVCOzZmStGzYlVjOrbieYhB5s2ocBqSjMfGQ22Ite2JDsM5LuBnWHUpGI97pp6mDfZZXi1R8x/YfaLH9c4uiUKUc8G28oHv6QdQSwMEFAAAAAgAAAAhUKUcDOWAAAAAigAAABYAAABuZXN0ZWQvYXNzZXRzL2JsdWUucG5n6wzwc+flkuJiYGDg9fRwCQLSPCDMwQYkw0pjngMpzgKPyGIGBm5hEGZkmDVHAijIWBzk7sSw7pzMSyCHJd3R15GBYWM/959EViBf3tPFMaSC8e1pQ0agWYc25P2zbWbLOzGfufOAcFQGJ9uqdiax1T0vHwKVMni6+rmsc0poAgBQSwECFAAUAAAACAAAACFQHk/w2IcAAACjAAAAFAAAAAAAAAAAAAAAAAAAAAAAbmVzdGVkL2NoZWNrcG9pbnQubWRQSwECFAAUAAAACAAAACFQpRwM5YAAAACKAAAAFgAAAAAAAAAAAAAAAAC5AAAAbmVzdGVkL2Fzc2V0cy9ibHVlLnBuZ1BLBQYAAAAAAgACAIYAAABtAQAAAAA=";
// ZIP64 sentinel sizes, but no required ZIP64 extra field in the central entry.
const malformedZip =
  "UEsDBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAAAAYmFkLm1kUEsBAgAAAAAAAAAAAAAAAAAAAAD//////////wYAAAAAAAAAAAAAAAAAAAAAAGJhZC5tZFBLBgYsAAAAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAQAAAAAAAAA0AAAAAAAAACQAAAAAAAAAUEsGBwAAAABYAAAAAAAAAAEAAABQSwUGAAAAAP////80AAAA/////wAA";

const extensions = new StoreExtensionManager(getInternalStoreExtensions()).get(
  "store",
);
const schema = new Schema().register(MyoxusSchemas);
let collection: TestWorkspace;

beforeEach(() => {
  collection = new TestWorkspace();
  collection.storeExtensions = extensions;
  collection.meta.initialize();
});

afterEach(() => {
  collection.forceStop();
  collection.dispose();
});

const importZip = (encoded: string) =>
  MarkdownTransformer.importMarkdownZip({
    collection,
    schema,
    extensions,
    imported: new Blob([Buffer.from(encoded, "base64")]),
  });

test("Markdown ZIP import preserves nested content, marks and image bytes", async () => {
  const { docIds: ids } = await importZip(validZip);
  expect(ids).toHaveLength(1);
  const store = collection.getDoc(ids[0])!.getStore({ extensions });
  const paragraphs = store
    .getBlocksByFlavour("myoxus:paragraph")
    .map((block) => block.model as ParagraphBlockModel);
  expect(paragraphs.map((block) => block.props.text.toString())).toEqual([
    "Dependency parser checkpoint",
    "Nested asset, bold text, and  .",
    "",
    "Details",
    "ZIP content preserved.",
  ]);
  expect(paragraphs[1].props.text.toDelta()).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        insert: "bold text",
        attributes: expect.objectContaining({ bold: true }),
      }),
      expect.objectContaining({
        insert: " ",
        attributes: {
          reference: {
            type: "LinkedPage",
            pageId: ids[0],
            title: "linked section",
            params: { mode: "page", blockIds: [paragraphs[3].id] },
          },
        },
      }),
    ]),
  );
  const images = store.getBlocksByFlavour("myoxus:image");
  expect(images).toHaveLength(1);
  const image = images[0].model as ImageBlockModel;
  const blob = await collection.blobSync.get(image.props.sourceId!);
  expect(blob).not.toBeNull();
  expect(blob!.size).toBe(138);
  expect(
    createHash("sha256")
      .update(new Uint8Array(await blob!.arrayBuffer()))
      .digest("hex"),
  ).toBe("f22737fc8459a97a88afaf217cb35394cb04b69a56ecc7788e26a413cfb0fa99");
});

async function documentLinkArchive() {
  return archiveWithEntries({
    "a/source.md":
      "---\ntitle: Source\n---\n[[../b/target|Target alias]] and [Relative alias](../b/target.md) and [[Duplicate]] and [[Missing]] and [[Target#anchor]]",
    "b/target.md":
      "---\ntitle: Target\n---\nBack to [[../a/source|Source alias]]",
    "c/one.md": "---\ntitle: Duplicate\n---\nOne",
    "d/two.md": "---\ntitle: Duplicate\n---\nTwo",
  });
}

async function archiveWithEntries(entries: Record<string, string>) {
  return new Blob([await createZipFixture(Object.entries(entries))]);
}

function referencesInDocument(id: string) {
  const store = collection.getDoc(id)!.getStore({ extensions });
  return store
    .getBlocksByFlavour("myoxus:paragraph")
    .flatMap((block) =>
      (block.model as ParagraphBlockModel).props.text
        .toDelta()
        .flatMap((delta) =>
          delta.attributes?.reference ? [delta.attributes.reference] : [],
        ),
    );
}

test("Markdown ZIP import resolves forward and cyclic links to each new batch", async () => {
  const { docIds: firstIds, diagnostics: firstDiagnostics } =
    await MarkdownTransformer.importMarkdownZip({
      collection,
      schema,
      extensions,
      imported: await documentLinkArchive(),
    });
  expect(firstDiagnostics).toEqual({
    unresolvedReferences: 3,
    unsupportedReferences: 0,
  });
  const firstByTitle = new Map(
    firstIds.map((id) => [collection.meta.getDocMeta(id)?.title, id]),
  );
  const firstSource = firstByTitle.get("Source")!;
  const firstTarget = firstByTitle.get("Target")!;
  expect(referencesInDocument(firstSource)).toEqual([
    expect.objectContaining({ pageId: firstTarget, title: "Target alias" }),
    expect.objectContaining({ pageId: firstTarget, title: "Relative alias" }),
  ]);
  expect(referencesInDocument(firstTarget)).toEqual([
    expect.objectContaining({ pageId: firstSource, title: "Source alias" }),
  ]);
  const firstSourceStore = collection
    .getDoc(firstSource)!
    .getStore({ extensions });
  expect(
    firstSourceStore
      .getBlocksByFlavour("myoxus:paragraph")
      .map((block) =>
        (block.model as ParagraphBlockModel).props.text.toString(),
      )
      .join(" "),
  ).toContain("[[Duplicate]] and [[Missing]] and [[Target#anchor]]");

  const { docIds: secondIds, diagnostics: secondDiagnostics } =
    await MarkdownTransformer.importMarkdownZip({
      collection,
      schema,
      extensions,
      imported: await documentLinkArchive(),
    });
  expect(secondDiagnostics).toEqual(firstDiagnostics);
  const secondByTitle = new Map(
    secondIds.map((id) => [collection.meta.getDocMeta(id)?.title, id]),
  );
  const secondSource = secondByTitle.get("Source")!;
  const secondTarget = secondByTitle.get("Target")!;
  expect(secondTarget).not.toBe(firstTarget);
  expect(referencesInDocument(secondSource)).toEqual([
    expect.objectContaining({ pageId: secondTarget, title: "Target alias" }),
    expect.objectContaining({ pageId: secondTarget, title: "Relative alias" }),
  ]);
});

test.each([
  ["root escape", { "../outside.md": "Outside" }],
  [
    "dot-normalization collision",
    { "docs/./same.md": "First", "docs/same.md": "Second" },
  ],
])(
  "rejects %s paths before document or asset persistence",
  async (_, entries) => {
    const imported = await archiveWithEntries({
      "assets/evidence.bin": "must not persist",
      ...entries,
    });

    await expect(
      MarkdownTransformer.importMarkdownZip({
        collection,
        schema,
        extensions,
        imported,
      }),
    ).rejects.toBeDefined();
    expect(collection.docs.size).toBe(0);
    expect(await collection.blobSync.list()).toEqual([]);
  },
);

test("keeps Unicode paths and duplicate basenames in distinct directories", async () => {
  const imported = await archiveWithEntries({
    "quelle/source.md":
      "---\ntitle: Source\n---\n[Unicode](../ziele/%C3%BCber/target.md) and [[../andere/target|Other]]",
    "ziele/über/target.md": "---\ntitle: Unicode target\n---\nUnicode",
    "andere/target.md": "---\ntitle: Other target\n---\nOther",
  });
  const { docIds } = await MarkdownTransformer.importMarkdownZip({
    collection,
    schema,
    extensions,
    imported,
  });
  const idsByTitle = new Map(
    docIds.map((id) => [collection.meta.getDocMeta(id)?.title, id]),
  );

  expect(referencesInDocument(idsByTitle.get("Source")!)).toEqual([
    expect.objectContaining({
      pageId: idsByTitle.get("Unicode target"),
      title: "Unicode",
    }),
    expect.objectContaining({
      pageId: idsByTitle.get("Other target"),
      title: "Other",
    }),
  ]);
});

test("malformed ZIP64 terminates and creates no partial document", async () => {
  await expect(importZip(malformedZip)).rejects.toThrow();
  expect(collection.docs.size).toBe(0);
});

test("ZIP admission rejects unsafe paths, changed payload CRC and oversized entries before document creation", async () => {
  const attempted = vi.spyOn(collection, "createDoc");
  try {
    const unsafe = await createZipFixture([["../outside.md", "Outside"]]);
    await expect(
      MarkdownTransformer.importMarkdownZip({
        collection,
        schema,
        extensions,
        imported: new Blob([unsafe]),
      }),
    ).rejects.toThrow(/Unsafe (?:ZIP entry path|filename)/);
    const good = await createZipFixture([["ordinary.md", "Hello CRC"]]);
    const changed = good.slice();
    const local = new DataView(changed.buffer);
    const content = 30 + local.getUint16(26, true) + local.getUint16(28, true);
    changed[content] ^= 1;
    await expect(
      MarkdownTransformer.importMarkdownZip({
        collection,
        schema,
        extensions,
        imported: new Blob([changed]),
      }),
    ).rejects.toThrow("Invalid CRC32");
    const oversized = good.slice();
    const central = oversized.findIndex(
      (_, index) =>
        oversized[index] === 0x50 &&
        oversized[index + 1] === 0x4b &&
        oversized[index + 2] === 1 &&
        oversized[index + 3] === 2,
    );
    expect(central).toBeGreaterThan(0);
    new DataView(oversized.buffer).setUint32(
      central + 24,
      50 * 1024 * 1024 + 1,
      true,
    );
    await expect(
      MarkdownTransformer.importMarkdownZip({
        collection,
        schema,
        extensions,
        imported: new Blob([oversized]),
      }),
    ).rejects.toThrow("output limits");
    expect(attempted).not.toHaveBeenCalled();
    expect(collection.docs.size).toBe(0);
  } finally {
    attempted.mockRestore();
  }
});

async function labelSnapshotArchive() {
  const entries: [string, string][] = [
    [
      "info.json",
      JSON.stringify({
        workspaceTags: [
          {
            id: "source-label",
            name: "Portable label",
            colorRole: "tag.blue",
            description: "Preserved",
          },
        ],
      }),
    ],
    [
      "document.snapshot.json",
      JSON.stringify({
        type: "page",
        meta: {
          id: "source-doc",
          title: "Portable document",
          createDate: 123,
          tags: ["source-label"],
        },
        blocks: {
          type: "block",
          id: "source-page",
          flavour: "myoxus:page",
          props: {},
          children: [],
        },
      }),
    ],
  ];
  return new File([await createZipFixture(entries)], "labels.zip");
}

test("snapshot label preflight, canonical transfer and compensation own the real importer", async () => {
  const file = await labelSnapshotArchive();
  const original = await file.text();
  const waitForSynced = vi.fn(async () => undefined);
  const workspace = {
    id: collection.id,
    docCollection: collection,
    engine: { doc: { waitForSynced } },
  } as unknown as Workspace;
  const moveManyToTrash = vi.fn((ids: string[]) =>
    ids.forEach((id) => collection.meta.setDocMeta(id, { trash: true })),
  );
  const docs = { moveManyToTrash } as unknown as DocsService;
  const gql = vi.fn(
    async ({
      variables,
    }: {
      variables: {
        input: {
          validateOnly: boolean;
          documents: { sourceId: string; externalId: string; tags: string[] }[];
        };
      };
    }) => {
      const { input } = variables;
      expect(input.documents[0].sourceId).toBe("source-doc");
      expect(input.documents[0].tags).toEqual(["source-label"]);
      if (input.validateOnly) expect(collection.docs.size).toBe(0);
      else {
        expect(input.documents[0].externalId).not.toBe("source-doc");
        expect(collection.getDoc(input.documents[0].externalId)).toBeDefined();
        expect(waitForSynced).toHaveBeenCalled();
      }
      return {
        importWorkspaceTags: {
          mappings: { "source-label": "canonical-label" },
          diagnostics: [],
          tags: [
            {
              id: "canonical-label",
              name: "Portable label",
              colorRole: "tag.blue",
              description: "Preserved",
              archived: false,
            },
          ],
        },
      };
    },
  );
  const graphql = { gql } as unknown as GraphQLService;
  const hooks = await snapshotLabelImportHooks(workspace, docs, graphql, file);
  const imported = await ZipTransformer.importDocs(
    collection,
    schema,
    file,
    hooks,
  );
  expect(imported).toHaveLength(1);
  expect(collection.meta.getDocMeta(imported[0].id)?.title).toBe(
    "Portable document",
  );
  expect(collection.meta.getDocMeta(imported[0].id)?.tags).toBeUndefined();
  expect(collection.meta.properties.tags?.options ?? []).toEqual([]);
  expect(gql).toHaveBeenCalledTimes(2);
  expect(await file.text()).toBe(original);
  expect(moveManyToTrash).not.toHaveBeenCalled();

  collection.removeDoc(imported[0].id);
  gql.mockRejectedValueOnce(new Error("Unknown portable label"));
  await expect(
    ZipTransformer.importDocs(collection, schema, file, hooks),
  ).rejects.toThrow("Unknown portable label");
  expect(collection.docs.size).toBe(0);
  expect(moveManyToTrash).not.toHaveBeenCalled();

  gql.mockResolvedValueOnce({
    importWorkspaceTags: {
      mappings: { "source-label": "canonical-label" },
      diagnostics: [],
      tags: [],
    },
  });
  gql.mockRejectedValueOnce(new Error("Assignment failed"));
  await expect(
    ZipTransformer.importDocs(collection, schema, file, hooks),
  ).rejects.toThrow("Assignment failed");
  expect(moveManyToTrash).toHaveBeenCalledOnce();
  const failed = moveManyToTrash.mock.calls[0][0];
  expect(failed).toHaveLength(1);
  expect(collection.meta.getDocMeta(failed[0])?.trash).toBe(true);
});

test("snapshot export uses canonical source identities and leaves live Yjs unchanged", async () => {
  const [doc] = await ZipTransformer.importDocs(
    collection,
    schema,
    await labelSnapshotArchive(),
  );
  collection.meta.setDocMeta(doc.id, { tags: ["stale-yjs"] });
  const labels = {
    workspaceTags: [
      {
        id: "archived",
        name: "Same",
        colorRole: "tag.blue",
        description: "Archived",
        archived: true,
        archivedAt: "2024-01-02T03:04:05Z",
      },
      {
        id: "active",
        name: "Same",
        colorRole: "tag.green",
        description: null,
        archived: false,
        archivedAt: null,
      },
    ],
    documents: [
      { sourceId: doc.id, externalId: doc.id, tags: ["archived", "active"] },
    ],
  };
  const gql = vi.fn(async () => ({
    workspace: { exportWorkspaceTags: labels },
  }));
  const remote = {
    flavour: "selfhosted",
    id: collection.id,
    scope: { get: () => ({ server: { scope: { get: () => ({ gql }) } } }) },
  } as unknown as Workspace;
  const projection = await exportWorkspaceLabels(remote, [doc.id]);
  const before = Y.encodeStateAsUpdate(collection.doc);
  let output: Blob | undefined;
  const capture = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation((blob) => {
      output = blob as Blob;
      return "blob:label-export";
    });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(() => {});
  try {
    await ZipTransformer.exportDocs(collection, schema, [doc], projection);
    expect(output).toBeDefined();
    const zip = await readZipFixture(output!);
    expect(
      JSON.parse(new TextDecoder().decode(zip.get("info.json"))).workspaceTags,
    ).toEqual(labels.workspaceTags);
    const snapshot = JSON.parse(
      new TextDecoder().decode(
        [...zip].find(([name]) => name.endsWith(".snapshot.json"))![1],
      ),
    );
    expect(snapshot.meta.id).toBe(doc.id);
    expect(snapshot.meta.tags).toEqual(["archived", "active"]);
    expect(snapshot.meta.title).toBe("Portable document");
    expect(Y.encodeStateAsUpdate(collection.doc)).toEqual(before);
    const validateLabels = vi.fn(async () => {});
    const applyLabels = vi.fn(async () => {});
    const imported = await ZipTransformer.importDocs(
      collection,
      schema,
      output!,
      {
        validateLabels,
        applyLabels,
        compensate: async () => {},
      },
    );
    expect(imported[0].id).not.toBe(snapshot.meta.id);
    expect(applyLabels).toHaveBeenCalledWith(
      {
        catalog: labels.workspaceTags,
        documents: [
          { sourceId: snapshot.meta.id, tags: ["archived", "active"] },
        ],
      },
      new Map([[snapshot.meta.id, imported[0].id]]),
    );
    expect(validateLabels).toHaveBeenCalledWith({
      catalog: labels.workspaceTags,
      documents: [{ sourceId: snapshot.meta.id, tags: ["archived", "active"] }],
    });
    gql.mockRejectedValueOnce(new Error("canonical read unavailable"));
    await expect(exportWorkspaceLabels(remote, [doc.id])).rejects.toThrow(
      "canonical read unavailable",
    );
    const local = { flavour: "local" } as Workspace;
    await expect(
      exportWorkspaceLabels(local, [doc.id]),
    ).resolves.toBeUndefined();
  } finally {
    capture.mockRestore();
    revoke.mockRestore();
    click.mockRestore();
  }
});
