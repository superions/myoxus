// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EditorHost } from "@virgultum/editor/std";

import { createAIScrollableTextRenderer } from "../components/ai-scrollable-text-renderer";
import {
  createMindmapExecuteRenderer,
  createMindmapRenderer,
} from "../messages/mindmap";
import { createSlidesRenderer } from "../messages/slides-preview";
import { createIframeRenderer } from "../messages/wrapper";
import type { AIContext } from "../utils/context";
import type { AIPanelController } from "../widgets/ai-panel/controller";
import { responseToExpandMindmap } from "./edgeless-response";
import { sourceMindmapSelection } from "./mindmap-source";

type AnswerRenderer = NonNullable<
  AIPanelController["config"]
>["answerRenderer"];

export function actionToAnswerRenderer<
  K extends keyof VirgultumPresets.AIActions,
>(id: K, host: EditorHost, ctx: AIContext): AnswerRenderer {
  switch (id) {
    case "brainstormMindmap": {
      const design = sourceMindmapSelection(ctx.get().selectedElements?.[0])
        ?.projection.design;
      return createMindmapRenderer(host, ctx, design);
    }
    case "expandMindmap":
      return createMindmapExecuteRenderer(host, ctx, responseToExpandMindmap);
    case "createSlides":
      return createSlidesRenderer(host, ctx);
    case "makeItReal":
      return createIframeRenderer(host, { height: 300 });
    default:
      return createAIScrollableTextRenderer({ host }, 320, true);
  }
}
