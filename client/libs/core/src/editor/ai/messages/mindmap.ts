// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { MindmapDesign } from "@virgultum/block-mermaid";
import type { EditorHost } from "@virgultum/editor/std";
import { createElement } from "react";

import { markdownToMindmap, MiniMindmapPreview } from "../mini-mindmap";
import { getAIPanelController } from "../utils/ai-widgets";
import type { AIContext } from "../utils/context";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

export function createMindmapRenderer(
  host: EditorHost,
  ctx: AIContext,
  style?: MindmapDesign,
): MyoxusAIPanelWidgetConfig["answerRenderer"] {
  return (answer, state) => {
    if (state === "generating") {
      getAIPanelController(host).generatingElement?.updateLoadingProgress(2);
    }
    if (state !== "finished") {
      return null;
    }

    return createElement(MiniMindmapPreview, {
      ctx,
      host,
      answer,
      mindmapStyle: style,
      templateShow: style === undefined,
      height: 300,
    });
  };
}

/**
 * Headless mindmap renderer that parses the completed response and invokes
 * the supplied canvas insertion handler once without displaying a preview.
 */
export function createMindmapExecuteRenderer(
  host: EditorHost,
  ctx: AIContext,
  handler: (host: EditorHost, ctx: AIContext) => void | Promise<void>,
): MyoxusAIPanelWidgetConfig["answerRenderer"] {
  let dispatched = false;

  return (answer, state) => {
    if (state !== "finished") {
      dispatched = false;
      getAIPanelController(host).generatingElement?.updateLoadingProgress(2);
      return null;
    }

    if (dispatched) return null;
    dispatched = true;

    try {
      const tree = markdownToMindmap(
        answer,
        host.store,
        host.std.store.provider,
      );
      ctx.set({ node: tree });
      if (tree) {
        Promise.resolve(handler(host, ctx)).catch(console.error);
      }
    } catch {
      ctx.set({ node: null });
    }

    return null;
  };
}
