import { MediaPreviewFrame, MediaPreviewImage } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import { createElement, type ReactNode } from "react";

import { getAIPanelWidget } from "../utils/ai-widgets";
import { preprocessHtml } from "../utils/html";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

type AnswerOptions = { height?: number };

function createPreviewRenderer(
  host: EditorHost,
  options: AnswerOptions | undefined,
  render: (answer: string) => ReactNode,
): MyoxusAIPanelWidgetConfig["answerRenderer"] {
  return (answer, state) => {
    if (state === "generating") {
      getAIPanelWidget(host).generatingElement.updateLoadingProgress(2);
      return null;
    }
    if (state !== "finished" && state !== "error") return null;
    return createElement(
      MediaPreviewFrame,
      { fill: true, style: { height: options?.height } },
      render(answer),
    );
  };
}

export function createIframeRenderer(
  host: EditorHost,
  options?: AnswerOptions,
) {
  return createPreviewRenderer(host, options, (answer) =>
    createElement("iframe", {
      title: "HTML",
      sandbox: "allow-scripts",
      scrolling: "no",
      srcDoc: preprocessHtml(answer),
      style: { width: "100%", height: "100%", border: 0 },
    }),
  );
}

export function createImageRenderer(host: EditorHost, options?: AnswerOptions) {
  return createPreviewRenderer(host, options, (answer) =>
    createElement(
      "div",
      {
        "data-testid": "ai-answer-image",
        style: { width: "100%", height: "100%" },
      },
      createElement(MediaPreviewImage, { alt: "", src: answer }),
    ),
  );
}
