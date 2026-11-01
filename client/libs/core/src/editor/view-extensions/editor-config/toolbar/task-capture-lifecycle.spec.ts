// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import { WorkspaceDialogService } from "@myoxus/core/modules/dialogs";
import { DocLinksService } from "@myoxus/core/modules/doc-link";
import { DocumentMetadataCacheService } from "@myoxus/core/modules/document-metadata/services/document-metadata-cache";
import type { EditorSettingExt } from "@myoxus/core/modules/editor-setting/entities/editor-setting";
import { GuardService } from "@myoxus/core/modules/permissions";
import { WorkspaceServerService } from "@myoxus/core/modules/server";
import type { FrameworkProvider } from "@myoxus/infra";

import { Container } from "@virgultum/editor/global/di";
import {
  DocModeProvider,
  ToolbarModuleIdentifier,
  type ToolbarContext,
} from "@virgultum/editor/shared/services";
import {
  Flags,
  Flag,
} from "../../../../../../../../virgultum/editor/shared/src/services/toolbar-service/flags";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createCustomToolbarExtension } from "./index";

function fixture() {
  const host = document.createElement("div");
  document.body.append(host);
  let resolvePermission!: (allowed: boolean) => void;
  const permission = new Promise<boolean>((resolve) => {
    resolvePermission = resolve;
  });
  const server = {
    id: "server",
    baseUrl: "https://myoxus.test",
    account$: { value: { id: "actor" } },
  };
  const metadata = {
    getModel: vi.fn<
      () => { metadata: { docId: string; workspaceId: string } } | null
    >(() => ({
      metadata: { docId: "immutable-doc", workspaceId: "workspace" },
    })),
    hydrateModel: vi.fn(async () => ({
      metadata: { docId: "immutable-doc", workspaceId: "workspace" },
    })),
    getIndexRowByExternalId: vi.fn(),
  };
  const dialogs = { open: vi.fn() };
  const services = new Map<unknown, unknown>([
    [DocumentMetadataCacheService, metadata],
    [WorkspaceServerService, { server }],
    [GuardService, { can: vi.fn(() => permission) }],
    [DocLinksService, { backlinks: { revalidateFromCloud: vi.fn() } }],
    [WorkspaceDialogService, dialogs],
  ]);
  const framework = {
    get: (service: unknown) => services.get(service),
  } as unknown as FrameworkProvider;
  const container = new Container();
  for (const extension of createCustomToolbarExtension(
    {} as EditorSettingExt,
    server.baseUrl,
    framework,
  ))
    extension.setup(container);
  const module = container
    .provider()
    .get(ToolbarModuleIdentifier("custom:myoxus:*"));
  const group = module.config.actions.find(
    (action) => action.id === "a.clipboard",
  );
  if (!group || !("actions" in group))
    throw new Error("Capture toolbar group missing");
  const action = group.actions.find(
    (action) => action.id === "capture-as-task",
  );
  if (!action || !("run" in action) || !action.run)
    throw new Error("Capture action missing");
  const flags = new Flags();
  let editorMode = "page";
  const ctx = {
    std: {
      getOptional: (id: unknown) =>
        id === DocModeProvider
          ? { getEditorMode: () => editorMode }
          : undefined,
      host,
      workspace: { id: "workspace" },
      store: { doc: { id: "source-key" }, getParent: () => null },
      selection: { find: () => undefined },
      command: {
        exec: () => [
          true,
          {
            selectedModels: [
              {
                id: "checkbox",
                flavour: "myoxus:list",
                text: { toString: () => "Follow up" },
              },
            ],
          },
        ],
      },
    },
    hide: () => flags.hide(),
    show: () => flags.show(),
  } as unknown as ToolbarContext;
  return {
    run: action.run,
    action,
    insertAction: group.actions.find(
      (item) => item.id === "insert-existing-task",
    ),
    module,
    ctx,
    flags,
    dialogs,
    metadata,
    server,
    resolvePermission,
    setMode: (mode: string) => {
      editorMode = mode;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("Capture toolbar modal ownership", () => {
  test("stays hidden through permission lookup and modal lifetime, then releases on actual close", async () => {
    const owner = fixture();
    const input = document.createElement("div");
    input.setAttribute("contenteditable", "true");
    owner.ctx.std.host.append(input);
    const toolbar = document.createElement("div");
    toolbar.setAttribute("data-range-sync-exclude", "true");
    const action = document.createElement("button");
    toolbar.append(action);
    owner.ctx.std.host.append(toolbar);
    action.focus();
    const opening = owner.run(owner.ctx);
    expect(owner.flags.check(Flag.Hiding)).toBe(true);
    expect(owner.dialogs.open).not.toHaveBeenCalled();
    owner.resolvePermission(true);
    await opening;
    expect(owner.dialogs.open).toHaveBeenCalledOnce();
    expect(owner.metadata.hydrateModel).not.toHaveBeenCalled();
    expect(owner.dialogs.open.mock.calls[0][1].returnFocusRef.current).toBe(
      input,
    );
    expect(owner.dialogs.open.mock.calls[0][1].sourceDocumentId).toBe(
      "immutable-doc",
    );
    expect(owner.flags.check(Flag.Hiding)).toBe(true);
    const onClose = owner.dialogs.open.mock.calls[0][2];
    onClose();
    expect(owner.flags.check(Flag.Hiding)).toBe(false);
    expect(owner.flags.check(Flag.Accepting)).toBe(false);
  });

  test.each(["success", "actor", "server", "workspace", "document"] as const)(
    "fresh source hydration freezes text and immutable identity, handling %s without adopting a later editor",
    async (transition) => {
      const f = fixture();
      f.metadata.getModel.mockReturnValue(null);
      let resolveHydration!: (model: {
        metadata: { docId: string; workspaceId: string };
      }) => void;
      f.metadata.hydrateModel.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveHydration = resolve;
          }),
      );
      const opening = f.run(f.ctx);
      expect(f.flags.check(Flag.Hiding)).toBe(true);
      expect(f.dialogs.open).not.toHaveBeenCalled();
      expect(f.metadata.hydrateModel).toHaveBeenCalledExactlyOnceWith(
        "source-key",
      );
      if (transition === "success")
        Object.defineProperty(f.ctx.std, "command", {
          value: {
            exec: () => [
              true,
              {
                selectedModels: [
                  {
                    id: "later-block",
                    flavour: "myoxus:paragraph",
                    text: { toString: () => "Later selection" },
                  },
                ],
              },
            ],
          },
        });
      if (transition === "actor") f.server.account$.value.id = "later-actor";
      if (transition === "server") f.server.id = "later-server";
      if (transition === "workspace")
        Object.defineProperty(f.ctx.std.workspace, "id", {
          value: "later-workspace",
        });
      if (transition === "document")
        Object.defineProperty(f.ctx.std.store, "doc", {
          value: { id: "later-document" },
        });
      resolveHydration({
        metadata: {
          docId: "fresh-immutable-doc",
          workspaceId: "workspace",
        },
      });
      f.resolvePermission(true);
      await opening;
      if (transition === "success") {
        expect(f.dialogs.open).toHaveBeenCalledWith(
          "task-capture",
          expect.objectContaining({
            sourceDocumentId: "fresh-immutable-doc",
            sourceExternalId: "source-key",
            blockId: "checkbox",
            excerpt: "Follow up",
          }),
          expect.any(Function),
        );
        expect(f.flags.check(Flag.Hiding)).toBe(true);
        f.dialogs.open.mock.calls[0][2]();
      } else expect(f.dialogs.open).not.toHaveBeenCalled();
      expect(f.flags.check(Flag.Hiding)).toBe(false);
      expect(f.flags.check(Flag.Accepting)).toBe(false);
    },
  );

  test.each(["denied"])(
    "releases toolbar when opening is %s without a dialog",
    async (failure) => {
      const owner = fixture();
      if (failure === "throw")
        owner.metadata.getModel.mockImplementationOnce(() => {
          throw new Error("Metadata unavailable");
        });
      const opening = owner.run(owner.ctx);
      if (failure === "owner-change")
        owner.server.account$.value.id = "other-actor";
      owner.resolvePermission(failure !== "denied");
      await opening;
      expect(owner.dialogs.open).not.toHaveBeenCalled();
      expect(owner.flags.check(Flag.Hiding)).toBe(false);
      expect(owner.flags.check(Flag.Accepting)).toBe(false);
    },
  );
});
