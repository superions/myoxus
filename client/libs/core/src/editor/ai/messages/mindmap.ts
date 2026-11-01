import type { MindmapDesign as MindmapStyle } from "@virgultum/block-mermaid";
import type { EditorHost } from "@virgultum/editor/std";
import { html, nothing } from "lit";

import { markdownToMindmap } from "../mini-mindmap";
import { getAIPanelWidget } from "../utils/ai-widgets";
import type { AIContext } from "../utils/context";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

export const createMindmapRenderer: (
  host: EditorHost,
  /**
   * Used to store data for later use during rendering.
   */
  ctx: AIContext,
  style?: MindmapStyle,
) => MyoxusAIPanelWidgetConfig["answerRenderer"] = (host, ctx, style) => {
  return (answer, state) => {
    if (state === "generating") {
      const panel = getAIPanelWidget(host);
      panel.generatingElement?.updateLoadingProgress(2);
    }

    if (state !== "finished") {
      return nothing;
    }

    return html`<mini-mindmap-preview
      .ctx=${ctx}
      .host=${host}
      .answer=${answer}
      .mindmapStyle=${style}
      .templateShow=${style === undefined}
      .height=${300}
    ></mini-mindmap-preview>`;
  };
};

/**
 * Creates a renderer for executing a handler.
 * The ai panel will not display anything after the answer is generated.
 */
export const createMindmapExecuteRenderer: (
  host: EditorHost,
  /**
   * Used to store data for later use during rendering.
   */
  ctx: AIContext,
  handler: (host: EditorHost, ctx: AIContext) => void | Promise<void>,
) => MyoxusAIPanelWidgetConfig["answerRenderer"] = (host, ctx, handler) => {
  let executed = false;
  return (answer, state) => {
    if (state !== "finished") {
      executed = false;
      const panel = getAIPanelWidget(host);
      panel.generatingElement?.updateLoadingProgress(2);
      return nothing;
    }

    if (executed) return nothing;
    executed = true;
    try {
      ctx.set({
        node: markdownToMindmap(answer, host.store, host.std.store.provider),
      });
      if (ctx.get().node)
        Promise.resolve(handler(host, ctx)).catch(console.error);
    } catch {
      ctx.set({ node: null });
    }

    return nothing;
  };
};
