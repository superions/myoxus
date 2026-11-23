// SPDX-License-Identifier: MIT
import {
  DocModeProvider,
  ThemeProvider,
} from "@virgultum/editor/shared/services";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import { GfxControllerIdentifier } from "@virgultum/editor/std/gfx";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import { DIAGRAM_DOC_KIND } from "../../modules/mermaid-diagrams";
import { createElement, useLayoutEffect, useRef, type Ref } from "react";

export interface EdgelessEditor {
  readonly std: BlockStdScope;
  readonly host: EditorHost | null;
  readonly updateComplete: Promise<boolean>;
}

const ordinaryCanvasBlocks = new Set([
  "myoxus:page",
  "myoxus:surface",
  "myoxus:note",
  "myoxus:paragraph",
  "myoxus:list",
  "myoxus:divider",
  "myoxus:callout",
  "myoxus:frame",
  "myoxus:edgeless-text",
]);

function canMountCanvasHost(doc: Store) {
  return (
    !doc.readonly &&
    doc.workspace.meta.getDocMeta(doc.id)?.docKind !== DIAGRAM_DOC_KIND &&
    doc.getAllModels().every(({ flavour }) => ordinaryCanvasBlocks.has(flavour))
  );
}

/** The viewport owns exactly one scope. Its element host still owns the
 * registered GFX views and unmounts them on disconnect. */
export function CanvasViewport({
  doc,
  specs,
  hostExtension,
  allowNativeHost,
  ref,
}: {
  doc: Store;
  specs: ExtensionType[];
  hostExtension?: ExtensionType;
  allowNativeHost: boolean;
  ref?: Ref<EdgelessEditor>;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = viewport.current!;
    const std = new BlockStdScope({
      store: doc,
      extensions: hostExtension ? [...specs, hostExtension] : specs,
    });
    const gfx = std.getOptional(GfxControllerIdentifier),
      mode = std.getOptional(DocModeProvider);
    gfx?.setModeResolver(mode ? () => mode.getEditorMode() : null);
    const stopTheme = std.get(ThemeProvider).edgeless$.subscribe((theme) => {
      el.dataset.theme = theme;
    });
    const session =
      allowNativeHost && canMountCanvasHost(doc) ? std.mountCanvas(el) : null;
    const host = session?.host ?? std.render();
    if (!session) el.replaceChildren(host);
    const handle: EdgelessEditor = {
      std,
      host,
      get updateComplete() {
        return host.updateComplete;
      },
    };
    const release = typeof ref === "function" ? ref(handle) : undefined;
    if (ref && typeof ref !== "function") ref.current = handle;
    return () => {
      stopTheme();
      if (release) release();
      else if (typeof ref === "function") ref(null);
      else if (ref) ref.current = null;
      if (session) session.dispose();
      else host.remove();
    };
  }, [doc, specs, hostExtension, allowNativeHost, ref]);
  return createElement("div", {
    className: "myoxus-edgeless-viewport",
    ref: viewport,
  });
}
