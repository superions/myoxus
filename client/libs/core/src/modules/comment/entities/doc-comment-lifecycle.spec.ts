/**
 * @vitest-environment happy-dom
 */

// SPDX-License-Identifier: AGPL-3.0-or-later

import { UserFriendlyError } from "@myoxus/error";
import { Framework, LiveData } from "@myoxus/infra";
import { afterEach, describe, expect, test, vi } from "vitest";

import { DocumentLifecycleStore } from "../../doc/stores/document-lifecycle";
import { DocDisplayMetaService } from "../../doc-display-meta";
import { SnapshotHelper } from "../services/snapshot-helper";
import type { DocComment } from "../types";
import { DocCommentEntity } from "./doc-comment";
import { DocCommentStore } from "./doc-comment-store";

afterEach(() => {
  vi.useRealTimers();
});

function createFixture() {
  const listComments = vi.fn().mockRejectedValue(
    new UserFriendlyError({
      status: 404,
      code: "DOC_NOT_FOUND",
      type: "NOT_FOUND",
      name: "DOC_NOT_FOUND",
      message: "not found: document",
    }),
  );
  const framework = new Framework();
  framework.entity(
    DocCommentStore,
    () =>
      ({
        listComments,
        listCommentChanges: vi.fn(),
      }) as any,
  );
  (framework as any).service(SnapshotHelper, {});
  (framework as any).service(DocDisplayMetaService, {
    title$: () => new LiveData("Document"),
  });
  framework.store(DocumentLifecycleStore);
  framework.entity(DocCommentEntity, [
    SnapshotHelper,
    DocDisplayMetaService,
    DocumentLifecycleStore,
  ]);
  const provider = framework.provider();
  return {
    entity: provider.createEntity(DocCommentEntity, {
      docId: "doc-1",
      std: null,
    }),
    lifecycle: provider.get(DocumentLifecycleStore),
    listComments,
  };
}

describe("comment terminal document lifecycle", () => {
  test("stops polling for more than two previous intervals after DOC_NOT_FOUND", async () => {
    vi.useFakeTimers();
    const { entity, lifecycle, listComments } = createFixture();

    entity.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.state("doc-1")).toBe("not-found");
    expect(listComments).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(listComments).toHaveBeenCalledOnce();
    expect(entity.comments$.value).toEqual([]);
    expect(entity.loading$.value).toBe(false);

    entity.dispose();
  });

  test("resumes with one initial request after an explicit new lifecycle", async () => {
    vi.useFakeTimers();
    const { entity, lifecycle, listComments } = createFixture();
    entity.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.state("doc-1")).toBe("not-found");
    listComments.mockResolvedValue({
      comments: [],
      hasNextPage: false,
      startCursor: "",
      endCursor: "",
    });

    lifecycle.beginAvailableLifecycle("doc-1", "created");
    await vi.advanceTimersByTimeAsync(0);

    expect(listComments).toHaveBeenCalledTimes(2);
    expect(lifecycle.state("doc-1")).toBe("available");
    entity.dispose();
  });

  test("does not request comments before a server create is confirmed", async () => {
    vi.useFakeTimers();
    const { entity, lifecycle, listComments } = createFixture();
    listComments.mockResolvedValue({
      comments: [],
      hasNextPage: false,
      startCursor: "",
      endCursor: "",
    });

    lifecycle.beginCreating("doc-1");
    entity.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listComments).not.toHaveBeenCalled();

    lifecycle.beginAvailableLifecycle("doc-1", "created");
    await vi.advanceTimersByTimeAsync(0);
    expect(listComments).toHaveBeenCalledOnce();
    entity.dispose();
  });
});

describe("Inbox reply targets", () => {
  test("highlights the containing thread for a loaded reply", () => {
    const { entity } = createFixture();
    entity.comments$.setValue([
      { id: "thread-1", replies: [{ id: "reply-1" }] },
    ] as DocComment[]);
    entity.highlightComment("reply-1");
    expect(entity.commentHighlighted$.value).toBe("thread-1");
    entity.highlightComment(null);
    expect(entity.commentHighlighted$.value).toBeNull();
    entity.dispose();
  });

  test("resolves the thread when comments hydrate after the deep link", () => {
    const { entity } = createFixture();
    entity.highlightComment("reply-1");
    expect(entity.commentHighlighted$.value).toBe("reply-1");
    entity.comments$.setValue([
      { id: "thread-1", replies: [{ id: "reply-1" }] },
    ] as DocComment[]);
    expect(entity.commentHighlighted$.value).toBe("thread-1");
    entity.dispose();
  });
});
