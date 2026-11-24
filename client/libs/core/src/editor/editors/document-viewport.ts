// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  DocModeProvider,
  ThemeProvider,
} from "@virgultum/editor/shared/services";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import { createElement, type Ref, useLayoutEffect, useRef } from "react";

/** A restored root or a newly inserted block stays in the same editing scope. */
export function DocumentViewport({
  mode = "page",
  doc,
  specs,
  hostExtension,
  className,
  ref,
}: {
  mode?: "page" | "edgeless";
  doc: Store;
  specs: ExtensionType[];
  hostExtension?: ExtensionType;
  className?: string;
  ref?: Ref<EditorHost>;
}) {
  const container = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = container.current!;
    const std = new BlockStdScope({
      store: doc,
      extensions: hostExtension ? [...specs, hostExtension] : specs,
    });
    const modeProvider = std.getOptional(DocModeProvider);
    std
      .getOptional(GfxControllerIdentifier)
      ?.setModeResolver(
        modeProvider ? () => modeProvider.getEditorMode() : null,
      );
    const theme = std.get(ThemeProvider);
    const stopTheme = (
      mode === "page" ? theme.app$ : theme.edgeless$
    ).subscribe((value) => {
      el.dataset.theme = value;
    });
    let host: EditorHost | undefined;
    let releaseRef: (() => void) | void;
    const attach = () => {
      if (host || !doc.root) return;
      host = std.render();
      if (mode === "edgeless") host.dataset.myoxusCanvasHost = "";
      el.append(host);
      if (typeof ref === "function") releaseRef = ref(host);
      else if (ref) ref.current = host;
    };
    const root = doc.slots.rootAdded.subscribe(attach);
    attach();
    return () => {
      root.unsubscribe();
      stopTheme();
      if (releaseRef) releaseRef();
      else if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
      host?.remove();
    };
  }, [doc, specs, hostExtension, mode, ref]);
  return createElement(mode === "page" ? "page-editor" : "div", {
    ref: container,
    className: mode === "page" ? className : "myoxus-edgeless-viewport",
  });
}
