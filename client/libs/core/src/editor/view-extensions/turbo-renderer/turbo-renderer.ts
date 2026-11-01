import { getWorkerUrl } from "@myoxus/env/worker";
import { CodeLayoutHandlerExtension } from "@virgultum/editor/blocks/code";
import { ImageLayoutHandlerExtension } from "@virgultum/editor/blocks/image";
import { ListLayoutHandlerExtension } from "@virgultum/editor/blocks/list";
import { NoteLayoutHandlerExtension } from "@virgultum/editor/blocks/note";
import { ParagraphLayoutHandlerExtension } from "@virgultum/editor/blocks/paragraph";
import {
  TurboRendererConfigFactory,
  ViewportTurboRendererExtension,
} from "@virgultum/editor/gfx/turbo-renderer";

function createPainterWorker() {
  const worker = new Worker(getWorkerUrl("turbo-painter"));
  return worker;
}

export const turboRendererExtension = [
  ParagraphLayoutHandlerExtension,
  ListLayoutHandlerExtension,
  NoteLayoutHandlerExtension,
  CodeLayoutHandlerExtension,
  ImageLayoutHandlerExtension,
  TurboRendererConfigFactory({
    options: {
      zoomThreshold: 1,
      debounceTime: 1000,
    },
    painterWorkerEntry: createPainterWorker,
  }),
  ViewportTurboRendererExtension,
];
