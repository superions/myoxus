// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom

import { Framework } from "@myoxus/infra";
import { describe, expect, test, vi } from "vitest";

import { WorkspaceScope } from "../workspace";
import {
  configureDialogModule,
  GlobalDialogService,
  WorkspaceDialogService,
} from ".";

function createProviders() {
  const framework = new Framework();
  configureDialogModule(framework);
  const root = framework.provider();
  const workspace = root.createScope(
    WorkspaceScope,
    {} as WorkspaceScope["props"],
  );
  return { root, workspace: workspace.framework };
}

describe("global dialog service scope", () => {
  test("shares one dialog stream between root and workspace scopes", () => {
    const { root, workspace } = createProviders();
    const workspaceDialogs = workspace.get(GlobalDialogService);
    const rootDialogs = root.get(GlobalDialogService);

    expect(workspaceDialogs).toBe(rootDialogs);

    workspaceDialogs.open("import-workspace", undefined);
    expect(rootDialogs.dialogs$.value).toMatchObject([
      { type: "import-workspace" },
    ]);
  });

  test("also shares the root-created instance with later workspace scopes", () => {
    const { root, workspace } = createProviders();
    const rootDialogs = root.get(GlobalDialogService);

    expect(workspace.get(GlobalDialogService)).toBe(rootDialogs);
  });
});

test("public workspace closes honor a shared owner veto and remove before exactly-once callbacks", async () => {
  const { workspace } = createProviders();
  const dialogs = workspace.get(WorkspaceDialogService);
  const canceled = Promise.withResolvers<boolean>();
  const beforeClose = vi.fn(() => canceled.promise);
  const callback = vi.fn();
  const guarded = dialogs.open("user-settings", {}, callback, { beforeClose });
  const laterCallback = vi.fn();
  const later = dialogs.open("workspace-settings", {}, laterCallback);
  const closing = dialogs.close(guarded);
  expect(dialogs.close(guarded, { status: "discarded" })).toBe(closing);
  const all = dialogs.closeAll();
  canceled.resolve(false);
  await expect(closing).resolves.toBe(false);
  await expect(all).resolves.toBe(false);
  expect(beforeClose).toHaveBeenCalledOnce();
  expect(dialogs.dialogs$.value.map((dialog) => dialog.id)).toEqual([
    guarded,
    later,
  ]);
  expect(callback).not.toHaveBeenCalled();
  expect(laterCallback).not.toHaveBeenCalled();
  beforeClose.mockResolvedValueOnce(true);
  callback.mockImplementation(() => {
    dialogs.close(guarded);
  });
  await expect(dialogs.closeAll()).resolves.toBe(true);
  expect(callback).toHaveBeenCalledOnce();
  expect(laterCallback).toHaveBeenCalledOnce();
  const failed = dialogs.open("user-settings", {}, undefined, {
    beforeClose: async () => {
      throw new Error("owner unavailable");
    },
  });
  await expect(dialogs.close(failed)).resolves.toBe(false);
  expect(dialogs.dialogs$.value.map((dialog) => dialog.id)).toEqual([failed]);
});
