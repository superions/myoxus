import {
  type MessageCommunicapable,
  OpConsumer,
  transfer,
} from "@myoxus/infra/op";
import { getPdfResourceOptions } from "@myoxus/env/worker";
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from "pdfjs-dist";
import * as pdfjs from "pdfjs-dist";
import { WorkerMessageHandler } from "pdfjs-dist/build/pdf.worker.mjs";
import { from, map } from "rxjs";

import type { ClientOps } from "./ops";
import type {
  PDFMeta,
  RenderPageOpts,
  ScreenAnnotation,
  TextItem,
  TextLayerContent,
} from "./types";

// This module is already a dedicated Myoxus Worker. Register pdfjs' official
// in-thread backend so PDFWorker uses its LoopbackPort instead of attempting to
// spawn a nested Worker whose URL cannot be resolved from this worker bundle.
(
  globalThis as typeof globalThis & {
    pdfjsWorker?: { WorkerMessageHandler: typeof WorkerMessageHandler };
  }
).pdfjsWorker = { WorkerMessageHandler };

class PDFRendererBackend extends OpConsumer<ClientOps> {
  private doc: PDFDocumentProxy | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;

  constructor(port: MessageCommunicapable) {
    super(port);
    this.register("open", this.open.bind(this));
    this.register("render", this.render.bind(this));
    this.register("getTextContent", this.getTextContent.bind(this));
    this.register("getAnnotations", this.getAnnotations.bind(this));
    this.register("getTextStrings", this.getTextStrings.bind(this));
  }

  open({ data }: { data: ArrayBuffer }) {
    return from(this.loadDocument(data));
  }

  private async loadDocument(data: ArrayBuffer): Promise<PDFMeta> {
    // PDF.js 6 gives document teardown ownership to the loading task.
    await this.loadingTask?.destroy();
    this.doc = null;

    this.loadingTask = pdfjs.getDocument({
      ...getPdfResourceOptions(pdfjs.version),
      data: new Uint8Array(data),
      // FontFace registration targets a Document and is not reliable inside
      // this dedicated renderer Worker. Let pdfjs paint embedded glyph paths
      // directly into the OffscreenCanvas instead of falling back to tofu.
      disableFontFace: true,
      useSystemFonts: false,
    });
    this.doc = await this.loadingTask.promise;

    const pageCount = this.doc.numPages;
    const pageSizes: Array<{ width: number; height: number }> = [];
    let maxWidth = 0;
    let maxHeight = 0;

    for (let i = 1; i <= pageCount; i++) {
      const page = await this.doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const width = Math.ceil(viewport.width);
      const height = Math.ceil(viewport.height);
      maxWidth = Math.max(maxWidth, width);
      maxHeight = Math.max(maxHeight, height);
      pageSizes.push({ width, height });
      page.cleanup();
    }

    return {
      pageCount,
      pageSizes,
      maxSize: { width: maxWidth, height: maxHeight },
    };
  }

  render(opts: RenderPageOpts) {
    return from(this.renderPage(opts)).pipe(
      map((bitmap) => transfer({ ...opts, bitmap }, [bitmap])),
    );
  }

  private async renderPage(opts: RenderPageOpts): Promise<ImageBitmap> {
    if (!this.doc) throw new Error("No document loaded");

    const page = await this.doc.getPage(opts.pageNum + 1);
    const scale = opts.scale ?? 1;
    const physWidth = Math.ceil(opts.width * scale);
    const physHeight = Math.ceil(opts.height * scale);

    const baseViewport = page.getViewport({ scale: 1 });
    const pdfScale = physWidth / baseViewport.width;
    const viewport = page.getViewport({ scale: pdfScale });

    const canvas = new OffscreenCanvas(physWidth, physHeight);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Failed to create PDF render canvas context");
    }

    try {
      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;
    } catch (error) {
      console.error("PDF page rendering failed", error);
      throw error;
    }

    const bitmap = canvas.transferToImageBitmap();
    page.cleanup();
    return bitmap;
  }

  getTextContent(opts: RenderPageOpts) {
    return from(this.extractTextContent(opts));
  }

  private async extractTextContent(
    opts: RenderPageOpts,
  ): Promise<TextLayerContent> {
    if (!this.doc) throw new Error("No document loaded");

    const page = await this.doc.getPage(opts.pageNum + 1);
    const scale = opts.scale ?? 1;
    const physWidth = Math.ceil(opts.width * scale);
    const physHeight = Math.ceil(opts.height * scale);

    const baseViewport = page.getViewport({ scale: 1 });
    const pdfScale = physWidth / baseViewport.width;

    const textContent = await page.getTextContent();
    const items: TextItem[] = [];

    for (const rawItem of textContent.items) {
      if (!("str" in rawItem) || !rawItem.str) continue;

      // rawItem.transform = [a, b, c, d, tx, ty] — text matrix in PDF space
      // (tx, ty) = baseline origin; (d) ≈ font ascent height in PDF units
      const [, b, , d, tx, ty] = rawItem.transform;

      // Font height in screen pixels (magnitude of the scale component)
      const fontHeight = Math.sqrt(d * d + b * b) * pdfScale;

      // Convert PDF bottom-left origin to screen top-left origin:
      //   screenX = tx * pdfScale
      //   screenY = physHeight - ty * pdfScale  (flip y)
      // Subtract fontHeight to get the top edge of the text span
      const screenX = tx * pdfScale;
      const screenY = physHeight - ty * pdfScale - fontHeight;
      const itemWidth = rawItem.width * pdfScale;

      items.push({
        str: rawItem.str,
        x: screenX,
        y: screenY,
        width: Math.max(itemWidth, 1),
        height: fontHeight,
      });
    }

    page.cleanup();
    return { items, physWidth, physHeight };
  }

  getAnnotations(opts: RenderPageOpts) {
    return from(this.extractAnnotations(opts));
  }

  private async extractAnnotations(
    opts: RenderPageOpts,
  ): Promise<ScreenAnnotation[]> {
    if (!this.doc) throw new Error("No document loaded");

    const page = await this.doc.getPage(opts.pageNum + 1);
    const scale = opts.scale ?? 1;
    const physWidth = Math.ceil(opts.width * scale);
    const physHeight = Math.ceil(opts.height * scale);

    const baseViewport = page.getViewport({ scale: 1 });
    const pdfScale = physWidth / baseViewport.width;

    const annotations = await page.getAnnotations();
    const result: ScreenAnnotation[] = [];

    for (const annot of annotations) {
      if (annot.subtype !== "Link") continue;

      const url: string | null =
        typeof annot.url === "string" ? annot.url : null;
      if (!url) continue;

      // annot.rect = [x1, y1, x2, y2] in PDF user space (y from bottom)
      const [x1, y1, x2, y2] = annot.rect as [number, number, number, number];

      // Convert to CSS pixels (divided by DPR)
      const cssX = (x1 * pdfScale) / scale;
      const cssY = (physHeight - y2 * pdfScale) / scale;
      const cssW = ((x2 - x1) * pdfScale) / scale;
      const cssH = ((y2 - y1) * pdfScale) / scale;

      result.push({
        type: "Link",
        url,
        x: cssX,
        y: cssY,
        width: cssW,
        height: cssH,
      });
    }

    page.cleanup();
    return result;
  }

  getTextStrings({ pageNum }: { pageNum: number }) {
    return from(this.extractTextStrings(pageNum));
  }

  private async extractTextStrings(pageNum: number): Promise<string[]> {
    if (!this.doc) throw new Error("No document loaded");
    const page = await this.doc.getPage(pageNum + 1);
    const textContent = await page.getTextContent();
    const strs: string[] = [];
    for (const item of textContent.items) {
      if ("str" in item && (item as { str: string }).str) {
        strs.push((item as { str: string }).str);
      }
    }
    page.cleanup();
    return strs;
  }
}

new PDFRendererBackend(self as MessageCommunicapable);
