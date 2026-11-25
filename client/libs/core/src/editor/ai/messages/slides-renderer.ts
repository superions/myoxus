// SPDX-License-Identifier: MIT

import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { AspectRatio, Card } from "@myoxus/ui-facade";
import { ViewExtensionManagerIdentifier } from "@virgultum/editor/ext-loader";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import { createElement, useEffect, useRef } from "react";
import { Doc as YDoc } from "yjs";

import { PPTBuilder } from "../slides/index";
import { getAIPanelWidget } from "../utils/ai-widgets";
import type { AIContext } from "../utils/context";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

export interface AISlidesRendererProps {
  text: string;
  host: EditorHost;
  ctx?: AIContext;
}

export function AISlidesRenderer({ text, host, ctx }: AISlidesRendererProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container || !host) return;

    let active = true;
    const collection = new WorkspaceImpl({
      id: "SLIDES_PREVIEW",
      rootDoc: new YDoc({ guid: "SLIDES_PREVIEW" }),
    });
    collection.meta.initialize();
    const doc = collection.createDoc().getStore();
    doc.load(() => {
      const pageBlockId = doc.addBlock("myoxus:page", {});
      doc.addBlock("myoxus:surface", {}, pageBlockId);
    });
    doc.resetHistory();

    const extensions = host.std
      .get(ViewExtensionManagerIdentifier)
      .get("preview-edgeless");
    const editorHost = new BlockStdScope({
      store: doc,
      extensions,
    }).render();
    container.replaceChildren(editorHost);

    const frameId = requestAnimationFrame(() => {
      if (!active) return;
      PPTBuilder(editorHost, host)
        ?.process(text)
        .then((res) => {
          if (active && res && ctx) {
            ctx.set({
              contents: res.contents as Parameters<
                AIContext["set"]
              >[0]["contents"],
              images: res.images,
            });
            getAIPanelWidget(host).requestUpdate();
          }
        })
        .catch(console.error);
    });

    return () => {
      active = false;
      cancelAnimationFrame(frameId);
      container.replaceChildren();
      collection.dispose();
    };
  }, [ctx, host, text]);

  return createElement(
    AspectRatio,
    { ratio: 16 / 9, w: "100%" },
    createElement(
      Card,
      {
        withBorder: true,
        padding: "none",
        "data-myoxus-ui-role": "ai-slides-preview",
        style: {
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        },
      },
      createElement("div", {
        ref: viewportRef,
        className: "myoxus-edgeless-viewport",
        style: {
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        },
      }),
    ),
  );
}

export const createSlidesRenderer: (
  host: EditorHost,
  ctx: AIContext,
) => MyoxusAIPanelWidgetConfig["answerRenderer"] = (host, ctx) => {
  return (answer, state) => {
    if (state === "generating") {
      const panel = getAIPanelWidget(host);
      panel.generatingElement?.updateLoadingProgress(2);
      return null;
    }

    if (state !== "finished" && state !== "error") {
      return null;
    }

    return createElement(AISlidesRenderer, { host, ctx, text: answer });
  };
};
