// SPDX-License-Identifier: MIT
import {
  DocModeProvider,
  ThemeProvider,
} from "@virgultum/editor/shared/services";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import {
  CanvasCameraHandoffIdentifier,
  type CanvasCamera,
  GfxControllerIdentifier,
} from "@virgultum/editor/std/gfx";
import type { ExtensionType, Store } from "@virgultum/editor/store";
import { createElement, useLayoutEffect, useRef, type Ref } from "react";

import { watchCanvasHandoff } from "./canvas-handoff";

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
  "myoxus:bpmn",
  "myoxus:mermaid",
]);

function canMountCanvasHost(doc: Store) {
  return (
    !doc.readonly &&
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
    const mount = (native: boolean, camera?: CanvasCamera) => {
      const extensions = [...specs];
      if (hostExtension) extensions.push(hostExtension);
      if (camera) {
        extensions.push({
          setup: (di) =>
            di.addImpl(CanvasCameraHandoffIdentifier, () => camera),
        });
      }
      const std = new BlockStdScope({ store: doc, extensions });
      const gfx = std.getOptional(GfxControllerIdentifier);
      const mode = std.getOptional(DocModeProvider);
      gfx?.setModeResolver(mode ? () => mode.getEditorMode() : null);
      const stopTheme = std.get(ThemeProvider).edgeless$.subscribe((theme) => {
        el.dataset.theme = theme;
      });
      const session = native ? std.mountCanvas(el) : null;
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
      return {
        host,
        gfx,
        dispose() {
          stopTheme();
          if (release) release();
          else if (typeof ref === "function") ref(null);
          else if (ref) ref.current = null;
          if (session) session.dispose();
          else host.remove();
        },
      };
    };

    const native = allowNativeHost && canMountCanvasHost(doc);
    let current = mount(native);
    const gfx = current.gfx;
    const stopSwitch =
      native && gfx
        ? watchCanvasHandoff(
            current.host,
            gfx,
            () => canMountCanvasHost(doc),
            () => {
              const { viewport, selection } = gfx;
              const camera = {
                zoom: viewport.zoom,
                centerX: viewport.centerX,
                centerY: viewport.centerY,
              };
              const locked = viewport.locked;
              const selectedIds = [...selection.selectedIds];
              const restoreFocus = current.host.contains(
                el.ownerDocument.activeElement,
              );
              current.dispose();
              const fallback = mount(false, camera);
              current = fallback;
              void fallback.host.updateComplete
                .then(() => {
                  if (!fallback.host.isConnected || !fallback.gfx) return;
                  fallback.gfx.viewport.locked = locked;
                  fallback.gfx.selection.set({ elements: selectedIds });
                  if (restoreFocus)
                    fallback.host.focus({ preventScroll: true });
                })
                .catch(console.error);
            },
          )
        : undefined;
    return () => {
      stopSwitch?.();
      current.dispose();
    };
  }, [doc, specs, hostExtension, allowNativeHost, ref]);
  return createElement("div", {
    className: "myoxus-edgeless-viewport",
    ref: viewport,
  });
}
