// SPDX-License-Identifier: AGPL-3.0-or-later
import { DisposableGroup } from "../../../primitives/disposable/index.js";
import type { BlockModel } from "../../../store/index.js";
import type { BlockStdScope } from "../../scope/std-scope.js";
import {
  createRetainedBlockView,
  type EditorHost,
  waitForRetainedRootView,
} from "./document-host.js";

/** Ordinary Canvas sessions own a DOM shell while retained views migrate at their own entries. */
export function createCanvasHost(
  std: BlockStdScope,
  doc: Document,
  targetModel?: BlockModel,
): EditorHost {
  const shell = doc.createElement("div");
  shell.dataset.myoxusCanvasHost = "";
  shell.tabIndex = targetModel ? -1 : 0;
  Object.assign(shell.style, {
    outline: "none",
    isolation: "isolate",
    height: targetModel ? "auto" : "100%",
  });
  const bindings = {
    std,
    store: std.store,
    disposables: new DisposableGroup(),
    rebuildViews() {
      const root = targetModel ?? std.store.root;
      const view = root && createRetainedBlockView(host, root);
      if (view) shell.replaceChildren(view);
      else shell.replaceChildren();
    },
    get command() {
      return std.command;
    },
    get event() {
      return std.event;
    },
    get range() {
      return std.range;
    },
    get selection() {
      return std.selection;
    },
    get view() {
      return std.view;
    },
    get updateComplete(): Promise<boolean> {
      const root = shell.firstElementChild;
      return waitForRetainedRootView(
        host,
        root instanceof HTMLElement ? root : null,
      );
    },
  };
  const host = Object.defineProperties(
    shell,
    Object.getOwnPropertyDescriptors(bindings),
  ) as HTMLDivElement & typeof bindings;
  return host;
}
