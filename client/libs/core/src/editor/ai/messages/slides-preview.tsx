// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { WorkspaceImpl } from "@myoxus/core/modules/workspace/impls/workspace";
import { AspectRatio, Card } from "@myoxus/ui-facade";
import { ViewExtensionManagerIdentifier } from "@virgultum/editor/ext-loader";
import { BlockStdScope, type EditorHost } from "@virgultum/editor/std";
import { createElement, useEffect, useRef } from "react";
import { Doc as YDoc } from "yjs";

import { createSlideDeckBuilder } from "../slides/slide-builder";
import { getAIPanelController } from "../utils/ai-widgets";
import type { AIContext } from "../utils/context";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

export interface AISlidesPreviewProps {
  text: string;
  host: EditorHost;
  ctx?: AIContext;
}

/**
 * Renders generated slide frames inside a disposable edgeless preview surface
 * and notifies the owning `AIPanelController` when insertable payloads are ready.
 */
export function AISlidesPreview({ text, host, ctx }: AISlidesPreviewProps) {
  const viewportRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = viewportRef.current;
    if (!container || !host) return;

    let active = true;
    const previewWorkspace = new WorkspaceImpl({
      id: "SLIDES_PREVIEW",
      rootDoc: new YDoc({ guid: "SLIDES_PREVIEW" }),
    });
    previewWorkspace.meta.initialize();
    const previewStore = previewWorkspace.createDoc().getStore();
    previewStore.load(() => {
      const pageBlockId = previewStore.addBlock("myoxus:page", {});
      previewStore.addBlock("myoxus:surface", {}, pageBlockId);
    });
    previewStore.resetHistory();

    const extensions = host.std
      .get(ViewExtensionManagerIdentifier)
      .get("preview-edgeless");
    const previewHost = new BlockStdScope({
      store: previewStore,
      extensions,
    }).render();
    container.replaceChildren(previewHost);

    const frameId = requestAnimationFrame(() => {
      if (!active) return;
      createSlideDeckBuilder(previewHost, host)
        .process(text)
        .then((result) => {
          if (!active || !result || !ctx) return;
          ctx.set({
            contents: result.contents as Parameters<
              AIContext["set"]
            >[0]["contents"],
            images: result.images,
          });
          getAIPanelController(host).notifyAnswerContextChanged();
        })
        .catch(console.error);
    });

    return () => {
      active = false;
      cancelAnimationFrame(frameId);
      container.replaceChildren();
      previewWorkspace.dispose();
    };
  }, [ctx, host, text]);

  return (
    <AspectRatio ratio={16 / 9} w="100%">
      <Card
        withBorder
        padding="none"
        data-myoxus-ui-role="ai-slides-preview"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          overflow: "hidden",
        }}
      >
        <div
          ref={viewportRef}
          className="myoxus-edgeless-viewport"
          style={{
            width: "100%",
            height: "100%",
            pointerEvents: "none",
          }}
        />
      </Card>
    </AspectRatio>
  );
}

export function createSlidesRenderer(
  host: EditorHost,
  ctx: AIContext,
): MyoxusAIPanelWidgetConfig["answerRenderer"] {
  return (answer, state) => {
    if (state === "generating") {
      getAIPanelController(host).generatingElement?.updateLoadingProgress(2);
      return null;
    }
    if (state !== "finished" && state !== "error") return null;
    return createElement(AISlidesPreview, { host, ctx, text: answer });
  };
}
