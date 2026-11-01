// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import type { Server } from "@myoxus/core/modules/server/entities/server";
import {
  createDatabaseTaskFromSourceMutation,
  databaseTaskCaptureReceiptQuery,
  DatabaseTaskCaptureState,
  DatabaseTaskSourceState,
  type DatabaseTaskCaptureResultFragment,
} from "@myoxus/graphql";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useCaptureTask } from "./use-capture-task";

const input = {
  databaseId: "project",
  sourceExternalId: "source-key",
  sourceDocumentId: "immutable-doc-uuid",
  blockId: "paragraph",
  title: "Original title",
  cells: [],
};
const receipt = (requestId: string): DatabaseTaskCaptureResultFragment => ({
  requestId,
  databaseId: "project",
  rowId: "canonical-row",
  editRevision: 1,
  state: DatabaseTaskCaptureState.Available,
  replayed: true,
  record: null,
  source: {
    sourceWorkspaceId: "workspace",
    documentId: "immutable-doc-uuid",
    externalId: "source-key",
    blockId: "paragraph",
    selectionAnchor: null,
    state: DatabaseTaskSourceState.Available,
    title: "Source",
  },
});
function setup(identity: string, gql = vi.fn()) {
  const server = { gql } as unknown as Server;
  const mount = (source = "immutable-doc-uuid") =>
    renderHook(() =>
      useCaptureTask(server, "workspace", identity, source, "Original excerpt"),
    );
  return { gql, mount };
}

describe("Task source capture admission", () => {
  it("retains an uncertain frozen request across dismissal and replays only on explicit action", async () => {
    const { gql, mount } = setup(
      "capture-reopen",
      vi.fn().mockRejectedValueOnce(new Error("lost response")),
    );
    const first = mount();
    await act(async () => {
      await first.result.current.submit(input);
    });
    const admitted = structuredClone(gql.mock.calls[0][0].variables.input);
    expect(first.result.current.phase).toBe("uncertain");
    expect(gql).toHaveBeenCalledTimes(1);
    first.unmount();
    const reopened = mount();
    expect(reopened.result.current.retained?.input).toEqual(admitted);
    expect(gql).toHaveBeenCalledTimes(1);
    gql.mockResolvedValueOnce({
      workspace: { databaseTaskCaptureReceipt: null },
    });
    await act(async () => {
      await reopened.result.current.review();
    });
    expect(gql.mock.calls[1][0].query).toBe(databaseTaskCaptureReceiptQuery);
    expect(reopened.result.current.phase).toBe("uncertain");
    expect(reopened.result.current.retained?.input).toEqual(admitted);
    gql.mockResolvedValueOnce({
      createDatabaseTaskFromSource: receipt(admitted.requestId),
    });
    await act(async () => {
      await reopened.result.current.replay();
    });
    expect(gql.mock.calls[2][0]).toEqual({
      query: createDatabaseTaskFromSourceMutation,
      variables: { input: admitted },
    });
    expect(reopened.result.current.result?.rowId).toBe("canonical-row");
    reopened.result.current.release();
  });

  it("unlocks a rejected draft only after successful absent receipt and keeps failed readback uncertain", async () => {
    const rejection = {
      extensions: { code: "MIX_DATABASE_CELL_VALUE_INVALID" },
    };
    const { gql, mount } = setup(
      "capture-rejected",
      vi
        .fn()
        .mockRejectedValueOnce(rejection)
        .mockRejectedValueOnce(new Error("readback offline")),
    );
    const hook = mount();
    await act(async () => {
      await hook.result.current.submit(input);
    });
    expect(hook.result.current.phase).toBe("uncertain");
    const admitted = gql.mock.calls[0][0].variables.input;
    gql.mockRejectedValueOnce(rejection).mockResolvedValueOnce({
      workspace: { databaseTaskCaptureReceipt: null },
    });
    await act(async () => {
      await hook.result.current.replay();
    });
    expect(gql.mock.calls[2][0].variables.input).toEqual(admitted);
    expect(hook.result.current.phase).toBe("draft");
    expect(hook.result.current.failure).toBe("invalid");
  });

  it("redacts confirmed metadata on external unmount and requires current receipt authorization before recovery", async () => {
    const gql = vi.fn();
    const onConfirmed = vi.fn();
    const server = { gql } as unknown as Server;
    const mount = () =>
      renderHook(() =>
        useCaptureTask(
          server,
          "workspace",
          "capture-unmount-privacy",
          "immutable-doc-uuid",
          "Original excerpt",
          onConfirmed,
        ),
      );
    gql.mockImplementationOnce(({ variables }) =>
      Promise.resolve({
        createDatabaseTaskFromSource: {
          ...receipt(variables.input.requestId),
          record: {
            row: {
              id: "canonical-row",
              databaseId: "project",
              rowKind: "task",
              title: "Private prior title",
              position: 0,
              createdBy: null,
              updatedBy: null,
              editRevision: 1,
              createdAt: "2026-10-15T00:00:00Z",
              updatedAt: "2026-10-15T00:00:00Z",
              deletedAt: null,
              contentDocument: null,
            },
            cells: [],
            cellRevisions: [],
            groupKeys: [],
            redacted: false,
          },
        },
      }),
    );
    const first = mount();
    await act(async () => {
      await first.result.current.submit(input);
    });
    expect(first.result.current.result?.record?.row.title).toBe(
      "Private prior title",
    );
    expect(onConfirmed).toHaveBeenCalledOnce();
    first.unmount();
    const reopened = mount();
    expect(reopened.result.current.result).toBeNull();
    expect(reopened.result.current.retained?.result).toBeNull();
    expect(reopened.result.current.phase).toBe("uncertain");
    gql.mockRejectedValueOnce({
      extensions: { code: "MIX_DATABASE_FORBIDDEN" },
    });
    await act(async () => {
      await reopened.result.current.review();
    });
    expect(reopened.result.current.result).toBeNull();
    expect(onConfirmed).toHaveBeenCalledOnce();
    expect(gql.mock.calls[1][0].query).toBe(databaseTaskCaptureReceiptQuery);
  });

  it("redacts a successful capture response arriving after unmount and does not auto-notify on reopening", async () => {
    let resolve!: (response: unknown) => void;
    const gql = vi.fn().mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onConfirmed = vi.fn();
    const server = { gql } as unknown as Server;
    const mount = () =>
      renderHook(() =>
        useCaptureTask(
          server,
          "workspace",
          "capture-late-unmount",
          "immutable-doc-uuid",
          "Original excerpt",
          onConfirmed,
        ),
      );
    const first = mount();
    let pending: Promise<void> | undefined;
    act(() => {
      pending = first.result.current.submit(input);
    });
    const requestId = gql.mock.calls[0][0].variables.input.requestId;
    first.unmount();
    await act(async () => {
      resolve({
        createDatabaseTaskFromSource: {
          ...receipt(requestId),
          source: {
            ...receipt(requestId).source,
            title: "Private late source",
          },
        },
      });
      await pending;
    });
    const reopened = mount();
    expect(reopened.result.current.retained?.input.requestId).toBe(requestId);
    expect(reopened.result.current.retained?.result).toBeNull();
    expect(reopened.result.current.result).toBeNull();
    expect(reopened.result.current.phase).toBe("uncertain");
    expect(onConfirmed).not.toHaveBeenCalled();
  });

  it("does not share source drafts across actors or documents", async () => {
    const { mount } = setup(
      "capture-source-scope",
      vi.fn().mockRejectedValue(new Error("offline")),
    );
    const first = mount();
    await act(async () => {
      await first.result.current.submit(input);
    });
    const otherSource = mount("other-document");
    expect(otherSource.result.current.phase).toBe("draft");
    expect(otherSource.result.current.retained).toBeUndefined();
    const otherActor = setup("different-actor").mount();
    expect(otherActor.result.current.retained).toBeUndefined();
  });
});
