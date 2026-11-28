// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { MediaPreviewFrame } from "@myoxus/ui-facade";
import type { EditorHost } from "@virgultum/editor/std";
import { createElement } from "react";

import { getAIPanelController } from "../utils/ai-widgets";
import { preprocessHtml } from "../utils/html";
import type { MyoxusAIPanelWidgetConfig } from "../widgets/ai-panel/type";

export function createIframeRenderer(
  host: EditorHost,
  options?: { height?: number },
): MyoxusAIPanelWidgetConfig["answerRenderer"] {
  return (answer, state) => {
    if (state === "generating") {
      getAIPanelController(host).generatingElement.updateLoadingProgress(2);
      return null;
    }
    if (state !== "finished" && state !== "error") {
      return null;
    }

    return createElement(
      MediaPreviewFrame,
      { fill: true, style: { height: options?.height } },
      createElement("iframe", {
        title: "HTML",
        sandbox: "allow-scripts",
        scrolling: "no",
        srcDoc: preprocessHtml(answer),
        style: { width: "100%", height: "100%", border: 0 },
      }),
    );
  };
}
