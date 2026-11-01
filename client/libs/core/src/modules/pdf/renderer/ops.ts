import type { OpSchema } from "@myoxus/infra/op";

import type {
  PDFMeta,
  RenderedPage,
  RenderPageOpts,
  ScreenAnnotation,
  TextLayerContent,
  TextStrings,
} from "./types";

export interface ClientOps extends OpSchema {
  open: [{ data: ArrayBuffer }, PDFMeta];
  render: [RenderPageOpts, RenderedPage];
  getTextContent: [RenderPageOpts, TextLayerContent];
  getAnnotations: [RenderPageOpts, ScreenAnnotation[]];
  getTextStrings: [{ pageNum: number }, TextStrings];
}
