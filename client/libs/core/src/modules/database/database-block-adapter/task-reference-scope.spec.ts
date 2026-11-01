// SPDX-License-Identifier: AGPL-3.0-or-later
import { expect, test } from "vitest";
import { resolveTaskReferenceScope } from "./task-reference-scope";
const workspaceId = "00000000-0000-4000-8000-000000000001";
const props = {
  serverWorkspaceId: workspaceId,
  serverDatabaseId: "00000000-0000-4000-8000-000000000002",
  serverRowId: "00000000-0000-4000-8000-000000000003",
  serverViewId: null,
};
test("compact container references require explicit native scope and never fall back to an embed", () => {
  const compact = {
    ...props,
    serverRowId: undefined,
    serverReferencePresentation: "compact" as const,
  };
  expect(resolveTaskReferenceScope(compact, workspaceId)).toEqual({
    kind: "container",
  });
  expect(
    resolveTaskReferenceScope(
      { ...props, serverReferencePresentation: "compact" },
      workspaceId,
    ).kind,
  ).toBe("task");
  for (const invalid of [
    { ...compact, serverWorkspaceId: undefined },
    { ...compact, serverWorkspaceId: "00000000-0000-4000-8000-000000000009" },
    { ...compact, serverDatabaseId: "malformed" },
    { ...compact, serverViewId: "view" },
    {
      ...compact,
      templateReference: {
        key: "context.container" as const,
        kind: "database" as const,
        optional: true as const,
      },
    },
  ])
    expect(resolveTaskReferenceScope(invalid, workspaceId)).toEqual({
      kind: "unavailable",
    });
});
test("explicit Row identity rejects foreign, partial, malformed and View-bearing references without a local fallback", () => {
  expect(resolveTaskReferenceScope(props, workspaceId)).toEqual({
    kind: "task",
    workspaceId,
    databaseId: props.serverDatabaseId,
    rowId: props.serverRowId,
  });
  for (const invalid of [
    { ...props, serverWorkspaceId: "00000000-0000-4000-8000-000000000009" },
    { ...props, serverRowId: "" },
    {
      ...props,
      serverRowId: undefined,
      serverDatabaseId: [props.serverDatabaseId] as unknown as string,
    },
    { ...props, serverRowId: "opaque-key" },
    { ...props, serverViewId: "view" },
    { ...props, serverViewId: "" },
    { ...props, serverViewId: 0 as unknown as string },
  ])
    expect(resolveTaskReferenceScope(invalid, workspaceId)).toEqual({
      kind: "unavailable",
    });
  expect(
    resolveTaskReferenceScope(
      { ...props, serverRowId: undefined },
      workspaceId,
    ),
  ).toEqual({ kind: "database" });
  expect(
    resolveTaskReferenceScope(
      { serverDatabaseId: props.serverDatabaseId, serverViewId: "view" },
      workspaceId,
    ),
  ).toEqual({ kind: "database" });
});
