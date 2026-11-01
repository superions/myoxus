/**
 * @vitest-environment happy-dom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  workspace: null as any,
  docsService: null as any,
  graphqlService: null as any,
  openPage: vi.fn(),
  notifyError: vi.fn(),
}));

vi.mock("@myoxus/core/modules/workspace", () => ({
  WorkspaceService: class WorkspaceService {},
}));

vi.mock("@myoxus/core/modules/doc", () => ({
  DocsService: class DocsService {},
}));

vi.mock("@myoxus/core/modules/server", () => ({
  GraphQLService: class GraphQLService {},
}));

vi.mock("@myoxus/infra", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@myoxus/infra")>()),
  useService: (service: { name?: string }) => {
    switch (service.name) {
      case "WorkspaceService":
        return { workspace: mocks.workspace };
      case "DocsService":
        return mocks.docsService;
      case "GraphQLService":
        return mocks.graphqlService;
      default:
        throw new Error(`unexpected service ${String(service.name)}`);
    }
  },
}));

vi.mock("../../use-navigate-helper", () => ({
  useNavigateHelper: () => ({ openPage: mocks.openPage }),
}));

vi.mock("@myoxus/ui-facade", () => ({ notify: { error: mocks.notifyError } }));

import { useDocumentOperations } from "../use-document-operations";

type DeleteStatus =
  | "Deleted"
  | "AlreadyDeleted"
  | "NotFound"
  | "NotTrashed"
  | "Forbidden"
  | "Failed";

function makeWorkspace(flavour = "cloud") {
  return {
    id: "workspace-1",
    flavour,
    engine: {
      doc: {
        deleteDoc: vi.fn(async () => undefined),
        updateAndWaitForSaved: vi.fn(
          async (_docId: string, update: () => void) => {
            update();
          },
        ),
        waitForSynced: vi.fn(async () => undefined),
      },
    },
    docCollection: {
      id: "workspace-1",
      removeDoc: vi.fn(),
    },
  };
}

function makeDeletePayload(
  documents: Array<{
    clientDocId: string;
    status: DeleteStatus;
    reason?: string | null;
  }>,
) {
  const count = (status: DeleteStatus) =>
    documents.filter((doc) => doc.status === status).length;
  return {
    requested: documents.length,
    deleted: count("Deleted"),
    alreadyDeleted: count("AlreadyDeleted"),
    notTrashed: count("NotTrashed"),
    forbidden: count("Forbidden"),
    failed: count("Failed"),
    notFound: count("NotFound"),
    rootMetaRemoved: count("Deleted"),
    documents: documents.map((doc) => ({
      resolvedDocId: null,
      title: null,
      reason: doc.reason ?? null,
      ...doc,
    })),
  };
}

describe("useDocumentOperations", () => {
  beforeEach(() => {
    mocks.openPage.mockReset();
    mocks.notifyError.mockReset();
    mocks.workspace = makeWorkspace();
    mocks.docsService = {
      list: {
        docsMap$: { value: new Map() },
        doc$: vi.fn(() => ({ value: null })),
      },
      duplicate: vi.fn(async () => "duplicated-doc"),
      moveManyToTrash: vi.fn(),
      removeManyFromRootMeta: vi.fn(),
    };
    mocks.graphqlService = {
      gql: vi.fn(async ({ query }: { query: { id: string } }) => {
        if (query.id === "emptyWorkspaceTrashMutation") {
          return {
            emptyWorkspaceTrash: makeDeletePayload([
              { clientDocId: "doc-a", status: "Deleted" },
            ]),
          };
        }
        return {
          deleteDocumentsPermanently: makeDeletePayload([
            { clientDocId: "doc-a", status: "Deleted" },
          ]),
        };
      }),
    };
  });

  test("move and restore use one local root-meta mutation without sync polling", async () => {
    const docA = { id: "doc-a", restoreFromTrash: vi.fn() };
    const docB = { id: "doc-b", restoreFromTrash: vi.fn() };
    mocks.docsService.list.docsMap$.value = new Map([
      [docA.id, docA],
      [docB.id, docB],
    ]);
    mocks.docsService.list.doc$ = vi.fn((id: string) => ({
      value: id === docA.id ? docA : docB,
    }));
    const { result } = renderHook(() => useDocumentOperations());

    await act(async () => {
      await result.current.moveToTrash(docA as any);
      await result.current.moveManyToTrash([
        docA as any,
        docB as any,
        docA as any,
      ]);
      await result.current.restoreFromTrash(docA.id);
    });

    expect(mocks.docsService.moveManyToTrash).toHaveBeenNthCalledWith(1, [
      "doc-a",
    ]);
    expect(mocks.docsService.moveManyToTrash).toHaveBeenNthCalledWith(2, [
      "doc-a",
      "doc-b",
    ]);
    expect(docA.restoreFromTrash).toHaveBeenCalledOnce();
    expect(
      mocks.workspace.engine.doc.updateAndWaitForSaved,
    ).toHaveBeenCalledTimes(3);
    expect(mocks.workspace.engine.doc.waitForSynced).not.toHaveBeenCalled();
    expect(mocks.graphqlService.gql).not.toHaveBeenCalled();
  });

  test("move to trash rejects a missing document before mutating root metadata", async () => {
    const { result } = renderHook(() => useDocumentOperations());

    await expect(result.current.moveToTrash("missing-doc")).rejects.toThrow(
      "Cannot move missing document to trash: missing-doc",
    );
    expect(mocks.docsService.moveManyToTrash).not.toHaveBeenCalled();
  });

  test("server delete acknowledges first and reconciles each returned status once", async () => {
    const restoreFromTrash = vi.fn();
    mocks.docsService.list.doc$ = vi.fn((id: string) => ({
      value: id === "doc-live" ? { restoreFromTrash } : null,
    }));
    mocks.graphqlService.gql = vi.fn(async () => ({
      deleteDocumentsPermanently: makeDeletePayload([
        { clientDocId: "doc-deleted", status: "Deleted" },
        { clientDocId: "doc-stale", status: "AlreadyDeleted" },
        { clientDocId: "doc-live", status: "NotTrashed" },
      ]),
    }));
    const { result } = renderHook(() => useDocumentOperations());

    let deleted = 0;
    await act(async () => {
      deleted = await result.current.permanentlyDeletePages([
        "doc-deleted",
        "doc-stale",
        "doc-live",
        "doc-deleted",
      ]);
    });

    expect(deleted).toBe(2);
    expect(mocks.graphqlService.gql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({
          id: "deleteDocumentsPermanentlyMutation",
        }),
        variables: {
          input: {
            workspaceId: "workspace-1",
            docIds: ["doc-deleted", "doc-stale", "doc-live"],
          },
        },
      }),
    );
    expect(mocks.docsService.removeManyFromRootMeta).toHaveBeenCalledOnce();
    expect(mocks.docsService.removeManyFromRootMeta).toHaveBeenCalledWith([
      "doc-deleted",
      "doc-stale",
    ]);
    expect(
      mocks.workspace.engine.doc.deleteDoc,
    ).toHaveBeenCalledExactlyOnceWith("doc-deleted");
    expect(restoreFromTrash).toHaveBeenCalledOnce();
    expect(mocks.graphqlService.gql.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.docsService.removeManyFromRootMeta.mock.invocationCallOrder[0],
    );
  });

  test("server rejection leaves every local document projection unchanged", async () => {
    mocks.graphqlService.gql = vi.fn(async () => ({
      deleteDocumentsPermanently: makeDeletePayload([
        {
          clientDocId: "doc-a",
          status: "Forbidden",
          reason: "missing permission",
        },
      ]),
    }));
    const { result } = renderHook(() => useDocumentOperations());

    await expect(
      act(async () => {
        await result.current.permanentlyDeletePages(["doc-a"]);
      }),
    ).rejects.toThrow(AggregateError);

    expect(mocks.docsService.removeManyFromRootMeta).not.toHaveBeenCalled();
    expect(mocks.workspace.engine.doc.deleteDoc).not.toHaveBeenCalled();
  });

  test("empty trash reconciles deleted, stale and server-live rows from one response", async () => {
    const restoreFromTrash = vi.fn();
    mocks.docsService.list.doc$ = vi.fn((id: string) => ({
      value: id === "doc-live" ? { restoreFromTrash } : null,
    }));
    mocks.graphqlService.gql = vi.fn(async () => ({
      emptyWorkspaceTrash: makeDeletePayload([
        { clientDocId: "doc-deleted", status: "Deleted" },
        { clientDocId: "doc-stale", status: "NotFound" },
        { clientDocId: "doc-live", status: "NotTrashed" },
      ]),
    }));
    const { result } = renderHook(() => useDocumentOperations());

    let reconciled = 0;
    await act(async () => {
      reconciled = await result.current.emptyTrash([
        "doc-deleted",
        "doc-stale",
        "doc-live",
      ]);
    });

    expect(reconciled).toBe(3);
    expect(mocks.graphqlService.gql).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        query: expect.objectContaining({ id: "emptyWorkspaceTrashMutation" }),
        variables: {
          input: {
            workspaceId: "workspace-1",
            clientVisibleDocIds: ["doc-deleted", "doc-stale", "doc-live"],
          },
        },
      }),
    );
    expect(mocks.docsService.removeManyFromRootMeta).toHaveBeenCalledWith([
      "doc-deleted",
      "doc-stale",
    ]);
    expect(
      mocks.workspace.engine.doc.deleteDoc,
    ).toHaveBeenCalledExactlyOnceWith("doc-deleted");
    expect(restoreFromTrash).toHaveBeenCalledOnce();
  });

  test("empty trash rejects an incomplete server classification without local mutation", async () => {
    mocks.graphqlService.gql = vi.fn(async () => ({
      emptyWorkspaceTrash: makeDeletePayload([
        { clientDocId: "doc-a", status: "Deleted" },
      ]),
    }));
    const { result } = renderHook(() => useDocumentOperations());

    await expect(
      act(async () => {
        await result.current.emptyTrash(["doc-a", "doc-unclassified"]);
      }),
    ).rejects.toThrow("did not classify 1 locally visible trash doc(s)");

    expect(mocks.docsService.removeManyFromRootMeta).not.toHaveBeenCalled();
    expect(mocks.workspace.engine.doc.deleteDoc).not.toHaveBeenCalled();
  });

  test("completion waits for local cleanup after the server acknowledgement", async () => {
    let release!: () => void;
    mocks.workspace.engine.doc.deleteDoc = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { result } = renderHook(() => useDocumentOperations());
    let completed = false;
    let deleting!: Promise<number>;
    await act(async () => {
      deleting = result.current.emptyTrash(["doc-a"]).then((count) => {
        completed = true;
        return count;
      });
      await vi.waitFor(() =>
        expect(mocks.workspace.engine.doc.deleteDoc).toHaveBeenCalledWith(
          "doc-a",
        ),
      );
    });
    expect(completed).toBe(false);
    expect(mocks.docsService.removeManyFromRootMeta).toHaveBeenCalledWith([
      "doc-a",
    ]);
    await act(async () => {
      release();
      expect(await deleting).toBe(1);
    });
    expect(completed).toBe(true);
  });

  test("local cleanup failure is reported after a committed server deletion", async () => {
    mocks.workspace.engine.doc.deleteDoc = vi
      .fn()
      .mockRejectedValue(new Error("local storage unavailable"));
    const { result } = renderHook(() => useDocumentOperations());
    await expect(
      act(async () => {
        await result.current.emptyTrash(["doc-a"]);
      }),
    ).rejects.toThrow("local storage unavailable");
    expect(mocks.docsService.removeManyFromRootMeta).toHaveBeenCalledWith([
      "doc-a",
    ]);
  });

  test("local workspaces keep their storage-owned delete path", async () => {
    mocks.workspace = makeWorkspace("local");
    const { result } = renderHook(() => useDocumentOperations());

    await act(async () => {
      await result.current.permanentlyDeletePages(["doc-local"]);
    });

    expect(mocks.graphqlService.gql).not.toHaveBeenCalled();
    expect(mocks.workspace.engine.doc.deleteDoc).toHaveBeenCalledWith(
      "doc-local",
    );
    expect(mocks.workspace.docCollection.removeDoc).toHaveBeenCalledWith(
      "doc-local",
    );
    expect(
      mocks.workspace.engine.doc.updateAndWaitForSaved,
    ).toHaveBeenCalledWith("workspace-1", expect.any(Function));
  });

  test("duplicate opens completed content and reports failure without navigation", async () => {
    const { result } = renderHook(() => useDocumentOperations());

    await act(async () => {
      await result.current.duplicate("source-doc");
    });

    expect(mocks.docsService.duplicate).toHaveBeenCalledWith("source-doc");
    expect(mocks.openPage).toHaveBeenCalledWith(
      "workspace-1",
      "duplicated-doc",
    );
    mocks.openPage.mockClear();
    mocks.docsService.duplicate.mockRejectedValueOnce(
      new Error("CONTENT_COPY_FAILED"),
    );
    await act(async () => {
      result.current.duplicate("source-doc");
    });
    expect(mocks.notifyError).toHaveBeenCalledWith(expect.any(String), {
      position: "top-center",
    });
    expect(mocks.openPage).not.toHaveBeenCalled();
  });
});
