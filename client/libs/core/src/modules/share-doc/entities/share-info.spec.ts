import { PublicDocMode } from "@myoxus/graphql";
import { Framework, Service, Store } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { ShareInfo } from "./share-info";

function createShareInfoFixture({
  serverDoc,
}: {
  serverDoc?: { id: string; public: boolean; mode: PublicDocMode };
}) {
  class TestWorkspaceService extends Service {
    workspace = { id: "workspace-share-test" };
  }

  class TestDocService extends Service {
    doc = { id: "doc-share-test" };
  }

  class TestShareStore extends Store {
    getShareInfoByDocId = vi.fn().mockResolvedValue(serverDoc);
    enableSharePage = vi.fn().mockResolvedValue(undefined);
    disableSharePage = vi.fn().mockResolvedValue(undefined);
  }

  class TestShareDocsListService extends Service {
    shareDocs = { refreshAfterMutation: vi.fn().mockResolvedValue(undefined) };
  }

  const framework = new Framework();
  framework
    .service(TestWorkspaceService)
    .service(TestDocService)
    .store(TestShareStore)
    .service(TestShareDocsListService)
    .entity(ShareInfo as any, [
      TestWorkspaceService,
      TestDocService,
      TestShareStore,
      TestShareDocsListService,
    ]);

  const provider = framework.provider();

  return {
    shareInfo: provider.createEntity(ShareInfo),
    shareStore: provider.get(TestShareStore),
    shareDocsListService: provider.get(TestShareDocsListService),
  };
}

describe("ShareInfo", () => {
  test("does not publish when the document is unavailable on the server", async () => {
    const { shareInfo, shareStore } = createShareInfoFixture({});

    await expect(
      shareInfo.enableShare(PublicDocMode.Page),
    ).rejects.toMatchObject({
      name: "DOC_NOT_FOUND",
      data: {
        docId: "doc-share-test",
        spaceId: "workspace-share-test",
      },
    });

    expect(shareStore.getShareInfoByDocId).toHaveBeenCalledWith(
      "workspace-share-test",
      "doc-share-test",
      undefined,
    );
    expect(shareStore.enableSharePage).not.toHaveBeenCalled();
  });

  test("publishes and refreshes the public-doc list after server preflight succeeds", async () => {
    const { shareInfo, shareStore, shareDocsListService } =
      createShareInfoFixture({
        serverDoc: {
          id: "doc-share-test",
          public: false,
          mode: PublicDocMode.Page,
        },
      });

    await shareInfo.enableShare(PublicDocMode.Page);

    expect(shareStore.enableSharePage).toHaveBeenCalledWith(
      "workspace-share-test",
      "doc-share-test",
      PublicDocMode.Page,
    );
    expect(
      shareDocsListService.shareDocs?.refreshAfterMutation,
    ).toHaveBeenCalledOnce();
  });
});
