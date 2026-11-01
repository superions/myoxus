/** @vitest-environment happy-dom */
// SPDX-License-Identifier: AGPL-3.0-or-later

import { Framework } from "@myoxus/infra";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { DocCommentContent } from "../types";
import { DocCommentStore } from "./doc-comment-store";

const stores: DocCommentStore[] = [];
afterEach(() => stores.splice(0).forEach((store) => store.dispose()));

const key = "comment-attachments/internal-doc/upload-résumé #?.png";
const downloadUrl =
  "https://workspace.example.test/api/workspaces/workspace-1/docs/external-doc/comment-attachments/comment-attachments%2Finternal-doc%2Fupload-r%C3%A9sum%C3%A9%20%23%3F.png";

function fixture(useDefaultServer = false) {
  const gql = vi.fn();
  const server = {
    baseUrl: "https://workspace.example.test",
    scope: { get: () => ({ gql }) },
  };
  const framework = new Framework();
  framework.entity(
    DocCommentStore,
    () =>
      new DocCommentStore(
        { workspace: { id: "workspace-1" } } as never,
        { server: useDefaultServer ? null : server } as never,
        { server: useDefaultServer ? server : null } as never,
      ),
  );
  const store = framework.provider().createEntity(DocCommentStore, {
    docId: "external-doc",
    getDocMode: () => "page",
    getDocTitle: () => "Attachment document",
  });
  stores.push(store);
  return { store, gql };
}

function content(url = key): DocCommentContent {
  return {
    snapshot: { blocks: { props: { type: "text" }, children: [] } } as never,
    attachments: [{ id: "attachment-1", filename: "résumé #?.png", url }],
  };
}

function comment() {
  return {
    id: "comment-1",
    content: content(),
    resolved: false,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    user: { id: "author-1", name: "Author", avatarUrl: null },
    replies: [
      {
        id: "reply-1",
        commentId: "comment-1",
        content: content(),
        createdAt: "2026-10-04T00:00:00Z",
        updatedAt: "2026-10-04T00:00:00Z",
        user: { id: "author-1", name: "Author", avatarUrl: null },
      },
    ],
  };
}

describe("comment attachment download projection", () => {
  test.each([false])(
    "resolves upload keys on the owning server (default=%s)",
    async (useDefaultServer) => {
      const { store, gql } = fixture(useDefaultServer);
      gql.mockResolvedValue({ uploadCommentAttachment: key });
      const file = new File(["image"], "résumé #?.png", { type: "image/png" });
      expect(await store.uploadCommentAttachment(file)).toBe(downloadUrl);
      expect(gql).toHaveBeenCalledWith(
        expect.objectContaining({
          variables: {
            workspaceId: "workspace-1",
            docId: "external-doc",
            attachment: file,
          },
        }),
      );
    },
  );

  test("projects stored keys in comments and replies without changing server content", async () => {
    const { store, gql } = fixture();
    const node = comment();
    gql.mockResolvedValue({
      workspace: {
        comments: {
          edges: [{ node }],
          pageInfo: { hasNextPage: false, startCursor: "a", endCursor: "b" },
        },
      },
    });
    const result = await store.listComments({});
    expect(result.comments[0].content?.attachments?.[0].url).toBe(downloadUrl);
    expect(result.comments[0].replies?.[0].content?.attachments?.[0].url).toBe(
      downloadUrl,
    );
    expect(node.content.attachments?.[0].url).toBe(key);
    expect(node.replies[0].content.attachments?.[0].url).toBe(key);
  });

  test("retains persisted download URLs and attachments not yet uploaded", async () => {
    const { store, gql } = fixture();
    const node = comment();
    node.content = content(
      "https://workspace.example.test/already-resolved.png",
    );
    node.content.attachments?.push({ id: "pending" });
    gql.mockResolvedValue({ createComment: node });
    const result = await store.createComment({ content: node.content });
    expect(result.content?.attachments).toEqual(node.content.attachments);
  });

  test("persists storage keys when creating or editing comments and replies", async () => {
    const { store, gql } = fixture();
    const draft = content(downloadUrl);
    gql.mockResolvedValue({
      createComment: comment(),
      createReply: comment().replies[0],
    });
    await store.createComment({ content: draft });
    await store.updateComment("comment-1", { content: draft });
    await store.createReply("comment-1", { content: draft });
    await store.updateReply("reply-1", { content: draft });
    for (const [request] of gql.mock.calls) {
      expect(request.variables.input.content.attachments[0].url).toBe(key);
    }
    expect(draft.attachments?.[0].url).toBe(downloadUrl);
  });
});
