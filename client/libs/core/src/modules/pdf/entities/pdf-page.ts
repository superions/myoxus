import { DebugLogger } from "@myoxus/debug";
import {
  catchErrorInto,
  effect,
  Entity,
  LiveData,
  mapInto,
} from "@myoxus/infra";
import { filter, map, switchMap } from "rxjs";

import type {
  RenderPageOpts,
  ScreenAnnotation,
  TextLayerContent,
} from "../renderer";
import type { PDF } from "./pdf";

const logger = new DebugLogger("myoxus:pdf:page:render");

export class PDFPage extends Entity<{ pdf: PDF; pageNum: number }> {
  readonly pageNum: number = this.props.pageNum;
  bitmap$ = new LiveData<ImageBitmap | null>(null);
  error$ = new LiveData<any>(null);
  textContent$ = new LiveData<TextLayerContent | null>(null);
  annotations$ = new LiveData<ScreenAnnotation[] | null>(null);

  render = effect(
    switchMap((opts: Omit<RenderPageOpts, "pageNum">) =>
      this.props.pdf.renderer.ob$("render", {
        ...opts,
        pageNum: this.pageNum,
      }),
    ),
    map((data) => data?.bitmap),
    filter(Boolean),
    mapInto(this.bitmap$),
    catchErrorInto(this.error$, (error) => {
      logger.error("Failed to render page", error);
      console.error("Failed to render PDF page", error);
    }),
  );

  requestTextContent = effect(
    switchMap((opts: Omit<RenderPageOpts, "pageNum">) =>
      this.props.pdf.renderer.ob$("getTextContent", {
        ...opts,
        pageNum: this.pageNum,
      }),
    ),
    filter(Boolean),
    mapInto(this.textContent$),
    catchErrorInto(this.error$, (error) => {
      logger.error("Failed to get text content", error);
      console.error("Failed to extract PDF text", error);
    }),
  );

  requestAnnotations = effect(
    switchMap((opts: Omit<RenderPageOpts, "pageNum">) =>
      this.props.pdf.renderer.ob$("getAnnotations", {
        ...opts,
        pageNum: this.pageNum,
      }),
    ),
    filter(Boolean),
    mapInto(this.annotations$),
    catchErrorInto(this.error$, (error) => {
      logger.error("Failed to get annotations", error);
      console.error("Failed to extract PDF annotations", error);
    }),
  );

  constructor() {
    super();
    this.disposables.push(() => this.render.unsubscribe);
  }
}
