import { ImageLayoutHandlerExtension } from "@virgultum/editor/blocks/image";
import { ListLayoutHandlerExtension } from "@virgultum/editor/blocks/list";
import { ParagraphLayoutHandlerExtension } from "@virgultum/editor/blocks/paragraph";
import {
  TurboRendererConfigFactory,
  ViewportTurboRendererExtension,
  ViewportTurboRendererIdentifier,
} from "@virgultum/editor/gfx/turbo-renderer";

import { addSampleNotes } from "./doc-generator.js";
import { createPainterWorker, setupEditor } from "./setup.js";

async function init() {
  const params = new URLSearchParams(location.search);
  const room = params.get("room") ?? "";
  if (room.startsWith("playwright")) {
    await setupEditor("page");
    return;
  }

  await setupEditor("edgeless", [
    ParagraphLayoutHandlerExtension,
    ListLayoutHandlerExtension,
    ImageLayoutHandlerExtension,
    TurboRendererConfigFactory({
      painterWorkerEntry: createPainterWorker,
    }),
    ViewportTurboRendererExtension,
  ]);
  addSampleNotes(doc, 100);
  doc.load();

  const renderer = editor.std.get(
    ViewportTurboRendererIdentifier,
  ) as ViewportTurboRendererExtension;
  window.renderer = renderer;
}

await init();
