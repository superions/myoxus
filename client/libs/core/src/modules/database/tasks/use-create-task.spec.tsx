// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import type { Server } from "@myoxus/core/modules/server/entities/server";
import {
  createDatabaseRowFromTemplateMutation,
  DatabaseTaskLifecycle,
  databaseTasksQuery,
} from "@myoxus/graphql";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { CreateRowFromTemplateVariables } from "../row-templates/use-create-row-from-template";
import { useCreateTask } from "./use-create-task";

const draft = { title: "  Native task  ", templateId: "", cells: [] };
const created = (id: string) => ({ createDatabaseRow: { row: { id } } });
function fixture(gql: (request: any) => Promise<any>, onCreated = vi.fn()) {
  return {
    server: { gql } as unknown as Server,
    createFromTemplate: (variables: CreateRowFromTemplateVariables) =>
      gql({ query: createDatabaseRowFromTemplateMutation, variables }),
    identity: "server/account/workspace",
    workspaceId: "workspace",
    databaseId: "project-a",
    timeZone: "Europe/Berlin",
    onCreated,
  };
}

describe("Task creation ownership and uncertain writes", () => {
  it("prevents duplicate writes and retains confirmed identity when a consumer refresh fails", async () => {
    let resolve!: (value: unknown) => void;
    const gql = vi.fn(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const onCreated = vi.fn(() => {
      throw new Error("later refresh failed");
    });
    const { result } = renderHook(() => useCreateTask(fixture(gql, onCreated)));
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.submit(draft);
      void result.current.submit(draft);
    });
    expect(gql).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(created("committed-row"));
      await expect(pending).rejects.toThrow("later refresh failed");
    });
    expect(result.current.phase).toBe("confirmed");
    expect(onCreated).toHaveBeenCalledWith({
      databaseId: "project-a",
      rowId: "committed-row",
      title: "Native task",
    });
    await act(async () => {
      await result.current.submit(draft);
    });
    expect(gql).toHaveBeenCalledTimes(1);
  });

  it("retains ambiguous post-commit errors and requires bounded open/closed readback before deliberate retry", async () => {
    const gql = vi.fn().mockRejectedValueOnce({
      message: "post-commit readback failed",
      extensions: { code: "MIX_DATABASE_FIELD_INVALID" },
    });
    const { result } = renderHook(() => useCreateTask(fixture(gql)));
    await act(async () => {
      await result.current.submit(draft);
    });
    expect(result.current.phase).toBe("uncertain");
    expect(result.current.failure).toBe("unconfirmed");
    await act(async () => {
      await result.current.submit(draft);
      result.current.allowAnotherAttempt();
    });
    expect(gql).toHaveBeenCalledTimes(1);
    const page = (totalCount: number, rowId: string) => ({
      workspace: {
        databaseTasks: {
          totalCount,
          rows: [{ rowId, databaseId: "project-a", title: "Native task" }],
        },
      },
    });
    gql
      .mockResolvedValueOnce(page(180, "moved-match"))
      .mockResolvedValueOnce(page(1, "moved-match"));
    await act(async () => {
      await result.current.review();
    });
    expect(
      gql.mock.calls
        .slice(1)
        .map(([request]) => [
          request.query,
          request.variables.input.lifecycle,
          request.variables.first,
        ]),
    ).toEqual([
      [databaseTasksQuery, DatabaseTaskLifecycle.Open, 100],
      [databaseTasksQuery, DatabaseTaskLifecycle.Closed, 100],
    ]);
    expect(result.current.reviewCount).toBe(181);
    expect(result.current.candidates.map((task) => task.rowId)).toEqual([
      "moved-match",
    ]);
    expect(result.current.phase).toBe("uncertain");
    act(() => result.current.allowAnotherAttempt());
    expect(result.current.phase).toBe("draft");
    expect(gql).toHaveBeenCalledTimes(3);
  });

  it("fences late completions even when an owner changes away and back", async () => {
    let resolveOld!: (value: unknown) => void;
    const gql = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveOld = r;
          }),
      )
      .mockResolvedValueOnce(created("current-row"));
    const props = fixture(gql);
    const { result, rerender } = renderHook(
      ({ identity, databaseId }) =>
        useCreateTask({ ...props, identity, databaseId }),
      {
        initialProps: {
          identity: props.identity,
          databaseId: props.databaseId,
        },
      },
    );
    let pending!: Promise<boolean>;
    act(() => {
      pending = result.current.submit(draft);
    });
    rerender({
      identity: "other-server/account/workspace",
      databaseId: "project-b",
    });
    rerender({ identity: props.identity, databaseId: props.databaseId });
    await act(async () => {
      resolveOld(created("old-row"));
      await pending;
    });
    expect(props.onCreated).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("draft");
    await act(async () => {
      await result.current.submit(draft);
    });
    expect(props.onCreated).toHaveBeenCalledOnce();
    expect(props.onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: "current-row" }),
    );
  });

  it("keeps traced preflight validation feedback editable and uses the selected native template", async () => {
    const gql = vi
      .fn()
      .mockRejectedValueOnce({
        message: "required field missing",
        extensions: { code: "MIX_DATABASE_FIELD_REQUIRED" },
      })
      .mockResolvedValueOnce({
        createDatabaseRowFromTemplate: { row: { id: "template-row" } },
      });
    const props = fixture(gql);
    const { result } = renderHook(() => useCreateTask(props));
    await act(async () => {
      await result.current.submit(draft);
    });
    expect(result.current.phase).toBe("draft");
    expect(result.current.failure).toBe("required");
    await act(async () => {
      await result.current.submit({
        ...draft,
        templateId: "native-template",
        cells: [{ fieldId: "assignees-role", value: { users: ["member"] } }],
      });
    });
    expect(gql.mock.calls[1][0].variables.input).toEqual({
      databaseId: "project-a",
      rowTemplateId: "native-template",
      title: "Native task",
      overrideCellValues: [
        { fieldId: "assignees-role", value: { users: ["member"] } },
      ],
    });
    expect(props.onCreated).toHaveBeenCalledWith(
      expect.objectContaining({ rowId: "template-row" }),
    );
  });
});
