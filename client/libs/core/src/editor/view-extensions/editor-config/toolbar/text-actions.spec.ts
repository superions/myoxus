// SPDX-License-Identifier: AGPL-3.0-or-later
/** @vitest-environment happy-dom */

import type { EditorSettingExt } from "@myoxus/core/modules/editor-setting/entities/editor-setting";
import { signal } from "@preact/signals-core";
import { Container } from "@virgultum/editor/global/di";
import {
  combine,
  resolveToolbarActions,
  ToolbarModuleIdentifier,
  type ToolbarAction,
  type ToolbarContext,
} from "@virgultum/editor/shared/services";
import { expect, test, vi } from "vitest";
import { createCustomToolbarExtension } from "./index";

test("resolves registered linked-doc opening and retains its preferred mode through a menu", () => {
  const open = vi.fn();
  const set = vi.fn();
  const settings = {
    settingSignal: signal({ openDocMode: "open-in-active-view" }),
    openDocMode: { set },
  } as unknown as EditorSettingExt;
  const container = new Container();
  for (const extension of createCustomToolbarExtension(
    settings,
    "https://myoxus.test",
  ))
    extension.setup(container);
  const modules = new Map(
    [...container.provider().getAll(ToolbarModuleIdentifier)].filter(
      ([id]) => !id.endsWith("*"),
    ),
  );
  const context = {
    toolbarRegistry: { modules },
    isPageMode: true,
    isEdgelessMode: false,
    getSurfaceModels: () => [],
    store: { id: "current-document" },
    getCurrentBlockByType: () => ({
      model: { props: { pageId: "linked-document" } },
      open,
    }),
    std: {
      get: () => ({
        isAllowed: (mode: string) => mode !== "open-in-center-peek",
      }),
    },
  } as unknown as ToolbarContext;
  const { primaryActionGroup } = resolveToolbarActions(
    context,
    "myoxus:embed-linked-doc",
  );
  const group = primaryActionGroup.find((action) => action.id === "A.open-doc");
  if (!group || !("actions" in group)) throw new Error("Open actions missing");
  const menu = group.actions.find(
    (action: ToolbarAction) => action.id === "modes",
  );
  const control =
    menu && "control" in menu && typeof menu.control !== "function"
      ? menu.control
      : undefined;
  if (control?.type !== "menu") throw new Error("Open modes missing");
  const action = combine(control.items, context).find((action) =>
    action.id.endsWith("open-in-new-tab"),
  );
  if (!action || !("run" in action) || !action.run)
    throw new Error("New-tab action missing");
  action.run(context);
  expect(open).toHaveBeenCalledExactlyOnceWith({ openMode: "open-in-new-tab" });
  expect(set).toHaveBeenCalledExactlyOnceWith("open-in-new-tab");
});
