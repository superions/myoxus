import { sourceMindmapSelection } from "./mindmap-source";
import type { EditorHost } from "@virgultum/editor/std";
import { ThemeProvider } from "@virgultum/shared/services";

import { createAIScrollableTextRenderer } from "../components/ai-scrollable-text-renderer";
import {
  createMindmapExecuteRenderer,
  createMindmapRenderer,
} from "../messages/mindmap";
import { createSlidesRenderer } from "../messages/slides-renderer";
import { createIframeRenderer, createImageRenderer } from "../messages/wrapper";
import type { AIContext } from "../utils/context";
import type { MyoxusAIPanelWidget } from "../widgets/ai-panel/ai-panel";
import { IMAGE_ACTIONS } from "./consts";
import { responseToExpandMindmap } from "./edgeless-response";

type AnswerRenderer = NonNullable<
  MyoxusAIPanelWidget["config"]
>["answerRenderer"];

export function actionToAnswerRenderer<
  T extends keyof VirgultumPresets.AIActions,
>(id: T, host: EditorHost, ctx: AIContext): AnswerRenderer {
  if (id === "brainstormMindmap") {
    return createMindmapRenderer(
      host,
      ctx,
      sourceMindmapSelection(ctx.get().selectedElements?.[0])?.projection
        .design,
    );
  }

  if (id === "expandMindmap") {
    return createMindmapExecuteRenderer(host, ctx, responseToExpandMindmap);
  }

  if (id === "createSlides") {
    return createSlidesRenderer(host, ctx);
  }

  if (id === "makeItReal") {
    return createIframeRenderer(host, { height: 300 });
  }

  if (IMAGE_ACTIONS.includes(id)) {
    return createImageRenderer(host, { height: 300 });
  }

  return createAIScrollableTextRenderer(
    {
      theme: host.std.get(ThemeProvider).app$,
    },
    320,
    true,
  );
}
