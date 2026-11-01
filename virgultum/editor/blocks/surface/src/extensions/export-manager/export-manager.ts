import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import { deserializeXYWH, type IBound } from "@virgultum/global/gfx";
import { ImageBlockModel, type RootBlockModel } from "@virgultum/model";
import { FetchUtils } from "@virgultum/shared/adapters";
import {
  CANVAS_EXPORT_IGNORE_TAGS,
  DEFAULT_IMAGE_PROXY_ENDPOINT,
} from "@virgultum/shared/consts";
import type { Viewport } from "@virgultum/shared/types";
import { isInsidePageEditor, matchModels } from "@virgultum/shared/utils";
import {
  type BlockComponent,
  type BlockStdScope,
  type EditorHost,
  StdIdentifier,
} from "@virgultum/std";
import {
  GfxBlockElementModel,
  type GfxController,
  GfxControllerIdentifier,
  type GfxModel,
  GfxPrimitiveElementModel,
  isGfxGroupCompatibleModel,
} from "@virgultum/std/gfx";
import type { ExtensionType, Store } from "@virgultum/store";

import { CanvasRenderer } from "../../renderer/canvas-renderer.js";
import type { SurfaceBlockComponent } from "../../surface-block.js";
import { getBgGridGap } from "../../utils/get-bg-grip-gap.js";
import {
  checkSnapshotPreflight,
  type EdgelessSnapshotPreflightResult,
} from "../../utils/snapshot-preflight.js";
import { FileExporter } from "./file-exporter.js";

// oxlint-disable-next-line typescript/consistent-type-imports
type Html2CanvasFunction = typeof import("html2canvas").default;

export type ExportOptions = {
  imageProxyEndpoint: string;
};

export type CaptureEdgelessSnapshotForExportOptions = {
  confirmPreflight?: (
    result: EdgelessSnapshotPreflightResult,
  ) => boolean | Promise<boolean>;
};

export class ExportManager {
  private readonly _exportOptions: ExportOptions = {
    imageProxyEndpoint: DEFAULT_IMAGE_PROXY_ENDPOINT,
  };

  replaceImgSrcWithSvg = async (element: HTMLElement) => {
    const imgList = Array.from(element.querySelectorAll("img"));
    // Create an array of promises
    const promises = imgList.map((img) => {
      return FetchUtils.fetchImage(
        img.src,
        undefined,
        this._exportOptions.imageProxyEndpoint,
      )
        .then((response) => response && response.blob())
        .then(async (blob) => {
          if (!blob) return;
          // If the file type is SVG, set svg width and height
          if (blob.type === "image/svg+xml") {
            // Parse the SVG
            const parser = new DOMParser();
            const svgDoc = parser.parseFromString(
              await blob.text(),
              "image/svg+xml",
            );
            const svgElement =
              svgDoc.documentElement as unknown as SVGSVGElement;

            // Check if the SVG has width and height attributes
            if (
              !svgElement.hasAttribute("width") &&
              !svgElement.hasAttribute("height")
            ) {
              // Get the viewBox
              const viewBox = svgElement.viewBox.baseVal;
              // Set the SVG width and height
              svgElement.setAttribute("width", `${viewBox.width}px`);
              svgElement.setAttribute("height", `${viewBox.height}px`);
            }

            // Replace the img src with the modified SVG
            const serializer = new XMLSerializer();
            const newSvgStr = serializer.serializeToString(svgElement);
            img.src =
              "data:image/svg+xml;charset=utf-8," +
              encodeURIComponent(newSvgStr);
          }
        });
    });

    // Wait for all promises to resolve
    await Promise.all(promises);
  };

  get doc(): Store {
    return this.std.store;
  }

  get editorHost(): EditorHost {
    return this.std.host;
  }

  constructor(readonly std: BlockStdScope) {}

  private _checkCanContinueToCanvas(pathName: string, editorMode: boolean) {
    if (
      location.pathname !== pathName ||
      isInsidePageEditor(this.editorHost) !== editorMode
    ) {
      throw new VirgultumError(
        ErrorCode.EdgelessExportError,
        "Unable to export content to canvas",
      );
    }
  }

  private async _checkReady() {
    const pathname = location.pathname;
    const editorMode = isInsidePageEditor(this.editorHost);

    const promise = new Promise((resolve, reject) => {
      let count = 0;
      const checkReactRender = setInterval(() => {
        try {
          this._checkCanContinueToCanvas(pathname, editorMode);
        } catch (e) {
          clearInterval(checkReactRender);
          reject(e);
        }
        const rootModel = this.doc.root;
        const rootComponent = this.doc.root
          ? rootModel
            ? this.editorHost.view.getBlock(rootModel.id)
            : null
          : null;
        const imageCard = rootComponent?.querySelector(
          "myoxus-image-fallback-card",
        );
        const isReady =
          !imageCard || imageCard.getAttribute("imageState") === "0";
        if (rootComponent && isReady) {
          clearInterval(checkReactRender);
          resolve(true);
        }
        count++;
        if (count > 10 * 60) {
          clearInterval(checkReactRender);
          resolve(false);
        }
      }, 100);
    });
    return promise;
  }

  private _createCanvas(bound: IBound, fillStyle: string) {
    const canvas = document.createElement("canvas");
    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D;

    canvas.width = (bound.w + 100) * dpr;
    canvas.height = (bound.h + 100) * dpr;

    ctx.scale(dpr, dpr);
    ctx.fillStyle = fillStyle;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    return { canvas, ctx };
  }

  private _disableMediaPrint() {
    document.querySelectorAll(".media-print").forEach((mediaPrint) => {
      mediaPrint.classList.add("hide");
    });
  }

  private async _docToCanvas(): Promise<HTMLCanvasElement | void> {
    const html2canvas = (await import("html2canvas")).default;
    if (!(html2canvas instanceof Function)) return;

    const pathname = location.pathname;
    const editorMode = isInsidePageEditor(this.editorHost);

    const rootComponent = getRootByEditorHost(this.editorHost);
    if (!rootComponent) return;
    const viewportElement = rootComponent.viewportElement;
    if (!viewportElement) return;
    const pageContainer = viewportElement.querySelector(
      ".myoxus-page-root-block-container",
    );
    const rect = pageContainer?.getBoundingClientRect();
    const { viewport } = rootComponent;
    if (!viewport) return;
    const pageWidth = rect?.width;
    const pageLeft = rect?.left ?? 0;
    const viewportHeight = viewportElement?.scrollHeight;

    const html2canvasOption = {
      ignoreElements: function (element: Element) {
        if (
          CANVAS_EXPORT_IGNORE_TAGS.includes(element.tagName) ||
          element.classList.contains("dg")
        ) {
          return true;
        } else if (
          (element.classList.contains("close") &&
            element.parentElement?.classList.contains(
              "meta-data-expanded-title",
            )) ||
          (element.classList.contains("expand") &&
            element.parentElement?.classList.contains("meta-data"))
        ) {
          // the close and expand buttons in myoxus-doc-meta-data is not needed to be showed
          return true;
        } else {
          return false;
        }
      },
      onclone: async (_documentClone: Document, element: HTMLElement) => {
        element.style.height = `${viewportHeight}px`;
        await this.replaceImgSrcWithSvg(element);
      },
      backgroundColor: window.getComputedStyle(viewportElement).backgroundColor,
      x: pageLeft - viewport.left,
      width: pageWidth,
      height: viewportHeight,
      useCORS: this._exportOptions.imageProxyEndpoint ? false : true,
      proxy: this._exportOptions.imageProxyEndpoint,
    };

    let data: HTMLCanvasElement;
    try {
      this._enableMediaPrint();
      data = await html2canvas(
        viewportElement as HTMLElement,
        html2canvasOption,
      );
    } finally {
      this._disableMediaPrint();
    }
    this._checkCanContinueToCanvas(pathname, editorMode);
    return data;
  }

  private _drawEdgelessBackground(
    ctx: CanvasRenderingContext2D,
    {
      size,
      backgroundColor,
      gridColor,
    }: {
      size: number;
      backgroundColor: string;
      gridColor: string;
    },
  ) {
    const svgImg = `<svg width='${ctx.canvas.width}px' height='${ctx.canvas.height}px' xmlns='http://www.w3.org/2000/svg' style='background-size:${size}px ${size}px;background-color:${backgroundColor}; background-image: radial-gradient(${gridColor} 1px, ${backgroundColor} 1px)'></svg>`;
    const img = new Image();
    const cleanup = () => {
      img.onload = null;
      img.onerror = null;
    };

    return new Promise<void>((resolve, reject) => {
      img.onload = () => {
        cleanup();
        ctx.drawImage(img, 0, 0);
        resolve();
      };
      img.onerror = (e) => {
        cleanup();
        reject(e);
      };

      img.src = `data:image/svg+xml,${encodeURIComponent(svgImg)}`;
    });
  }

  private _enableMediaPrint() {
    document.querySelectorAll(".media-print").forEach((mediaPrint) => {
      mediaPrint.classList.remove("hide");
    });
  }

  private async _html2canvas(
    htmlElement: HTMLElement,
    options: Parameters<Html2CanvasFunction>[1] = {},
  ) {
    const html2canvas = (await import("html2canvas"))
      .default as unknown as Html2CanvasFunction;
    const html2canvasOption = {
      ignoreElements: function (element: Element) {
        if (
          CANVAS_EXPORT_IGNORE_TAGS.includes(element.tagName) ||
          element.classList.contains("dg")
        ) {
          return true;
        } else {
          return false;
        }
      },
      onclone: async (documentClone: Document, element: HTMLElement) => {
        // html2canvas can't support transform feature
        element.style.setProperty("transform", "none");
        const layer = element.classList.contains(".myoxus-edgeless-layer")
          ? element
          : null;

        if (layer instanceof HTMLElement) {
          layer.style.setProperty("transform", "none");
        }

        const boxShadowEles = documentClone.querySelectorAll(
          "[style*='box-shadow']",
        );
        boxShadowEles.forEach(function (element) {
          if (element instanceof HTMLElement) {
            element.style.setProperty("box-shadow", "none");
          }
        });

        await this.replaceImgSrcWithSvg(element);
      },
      useCORS: this._exportOptions.imageProxyEndpoint ? false : true,
      proxy: this._exportOptions.imageProxyEndpoint,
    };

    let data: HTMLCanvasElement;
    try {
      this._enableMediaPrint();
      data = await html2canvas(
        htmlElement,
        Object.assign(html2canvasOption, options),
      );
    } finally {
      this._disableMediaPrint();
    }
    return data;
  }

  private async _toCanvas(): Promise<HTMLCanvasElement | void> {
    try {
      await this._checkReady();
    } catch (e: unknown) {
      console.error("Failed to export to canvas");
      console.error(e);
      return;
    }

    if (isInsidePageEditor(this.editorHost)) {
      return this._docToCanvas();
    } else {
      const rootModel = this.doc.root;
      if (!rootModel) return;

      const gfx = this.editorHost.std.get(GfxControllerIdentifier);
      const surfaceBlock = gfx.surfaceComponent as SurfaceBlockComponent | null;
      if (!surfaceBlock) return;
      const bound = gfx.elementsBound;
      if (!(surfaceBlock.renderer instanceof CanvasRenderer)) {
        return;
      }
      return this.edgelessToCanvas(surfaceBlock.renderer, bound, gfx);
    }
  }

  // TODO: refactor of this part
  async edgelessToCanvas(
    surfaceRenderer: CanvasRenderer,
    bound: IBound,
    gfx: GfxController,
    blocks?: GfxBlockElementModel[],
    elements?: GfxPrimitiveElementModel[],
    edgelessBackground?: {
      zoom: number;
    },
  ): Promise<HTMLCanvasElement | undefined> {
    if (!(surfaceRenderer instanceof CanvasRenderer)) {
      console.warn(
        "ExportManager.edgelessToCanvas was called with an invalid renderer type. Expected CanvasRenderer.",
      );
      return undefined;
    }

    const rootModel = this.doc.root;
    if (!rootModel) return;

    const pathname = location.pathname;
    const editorMode = isInsidePageEditor(this.editorHost);
    const rootComponent = getRootByEditorHost(this.editorHost);
    if (!rootComponent) return;
    const viewportElement = rootComponent.viewportElement;
    if (!viewportElement) return;
    const containerComputedStyle = window.getComputedStyle(viewportElement);

    const container = rootComponent.querySelector(
      ".myoxus-block-children-container",
    );

    if (!container) return;

    const { ctx, canvas } = this._createCanvas(
      bound,
      window.getComputedStyle(container).backgroundColor,
    );

    if (edgelessBackground) {
      await this._drawEdgelessBackground(ctx, {
        backgroundColor: containerComputedStyle.getPropertyValue(
          "--myoxus-background-primary-color",
        ),
        size: getBgGridGap(edgelessBackground.zoom),
        gridColor: containerComputedStyle.getPropertyValue(
          "--myoxus-edgeless-grid-color",
        ),
      });
    }

    if (!blocks && !elements) {
      blocks = gfx.getElementsByBound(bound, { type: "block" });
      elements = gfx.getElementsByBound(bound, { type: "canvas" });
    } else {
      elements = elements ?? [];
      blocks = blocks ?? [];
      const blockSet = new Set<GfxBlockElementModel>();
      const elementSet = new Set<GfxPrimitiveElementModel>();
      const addFn = (item: GfxModel) => {
        if (item instanceof GfxBlockElementModel) {
          blockSet.add(item);
        } else if (item instanceof GfxPrimitiveElementModel) {
          elementSet.add(item);
        }
      };
      [...elements, ...blocks].forEach((item) => {
        addFn(item);
        if (isGfxGroupCompatibleModel(item)) {
          item.descendantElements.forEach((descendant) => {
            addFn(descendant);
          });
        }
      });
      elements = [...elementSet];
      blocks = [...blockSet];
    }

    for (const block of blocks) {
      if (matchModels(block, [ImageBlockModel])) {
        if (!block.props.sourceId) return;

        const blob = await block.store.blobSync.get(block.props.sourceId);
        if (!blob) return;

        const blobToImage = (blob: Blob) =>
          new Promise<HTMLImageElement>((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = URL.createObjectURL(blob);
          });
        const blockBound = xywhArrayToObject(block);
        ctx.drawImage(
          await blobToImage(blob),
          blockBound.x - bound.x,
          blockBound.y - bound.y,
          blockBound.w,
          blockBound.h,
        );
      }
      const blockComponent = this.editorHost.view.getBlock(block.id);
      if (blockComponent) {
        const blockBound = xywhArrayToObject(block);
        const canvasData = await this._html2canvas(
          blockComponent as HTMLElement,
        );
        ctx.drawImage(
          canvasData,
          blockBound.x - bound.x + 50,
          blockBound.y - bound.y + 50,
          blockBound.w,
          blockBound.h,
        );
      }

      this._checkCanContinueToCanvas(pathname, editorMode);
    }

    const surfaceCanvas = surfaceRenderer.getCanvasByBound(bound, elements);
    ctx.drawImage(surfaceCanvas, 50, 50, bound.w, bound.h);

    return canvas;
  }

  async exportPng() {
    const rootModel = this.doc.root;
    if (!rootModel) return;
    const canvasImage = await this._toCanvas();
    if (!canvasImage) {
      return;
    }

    FileExporter.exportPng(
      (this.doc.root as RootBlockModel).props.title.toString(),
      canvasImage.toDataURL("image/png"),
    );
  }

  /**
   * Capture the edgeless surface to a PNG, upload it as a workspace blob, and
   * write the contract props (`exportSnapshotBlobId/Width/Height`) onto the
   * surface block so the server-side PDF builder can resolve the snapshot.
   *
   * Returns true on success, false when no surface block exists or canvas
   * capture fails. Side effect: a Yjs prop write on the surface block plus a
   * blob upload — callers must run this from inside an action that can wait
   * for the blob to flush before kicking off a server-side export.
   *
   * Designed for the edgeless PDF-export path. Page-mode docs do not need
   * this — they have a typesettable block tree the server can render directly.
   */
  async captureEdgelessSnapshotForExport(
    options: CaptureEdgelessSnapshotForExportOptions = {},
  ): Promise<boolean> {
    const rootModel = this.doc.root;
    if (!rootModel) return false;

    const surfaceModel = this.doc.getModelsByFlavour("myoxus:surface")[0];
    if (!surfaceModel) return false;

    const rawCanvas = await this._toCanvas();
    if (!rawCanvas) return false;

    const preflight = checkSnapshotPreflight(rawCanvas.width, rawCanvas.height);
    if (
      preflight.severity !== "ok" &&
      options.confirmPreflight &&
      !(await options.confirmPreflight(preflight))
    ) {
      return false;
    }

    const { canvas, blob } = await encodeWithinSnapshotLimits(rawCanvas);
    if (!blob) return false;

    const blobId = await this.doc.workspace.blobSync.set(blob);

    this.doc.updateBlock(surfaceModel, {
      exportSnapshotBlobId: blobId,
      exportSnapshotWidth: canvas.width,
      exportSnapshotHeight: canvas.height,
    });

    return true;
  }
}

// ─── Edgeless snapshot limits (mirror of server-side EdgelessSnapshotLimits) ───
// Keep these in sync with `server/crates/pdf_export/src/ir/block.rs`
// (`EdgelessSnapshotLimits::DEFAULT`). The contract is symmetric: clients
// downscale before upload, the server validates and rejects with
// `error_class="TooLarge"` on overshoots so a single runaway canvas cannot
// blow up the renderer or the blob store. Mirroring the constants client-side
// means the user sees a successful export instead of an opaque server reject.
const SNAPSHOT_MAX_DIMENSION_PX = 8192;
const SNAPSHOT_MAX_TOTAL_PIXELS = 4096 * 4096;
const SNAPSHOT_MAX_SIZE_BYTES = 32 * 1024 * 1024;

/** Compute the scale factor (≤ 1) needed so width/height/total-pixels all fit
 *  the dimension and total-pixel limits. Returns 1 when no scaling is needed. */
export function computeSnapshotScale(
  width: number,
  height: number,
  maxDim = SNAPSHOT_MAX_DIMENSION_PX,
  maxTotalPixels = SNAPSHOT_MAX_TOTAL_PIXELS,
): number {
  if (width <= 0 || height <= 0) return 1;
  const dimScale = Math.min(maxDim / width, maxDim / height, 1);
  const totalPixelScale = Math.min(
    Math.sqrt(maxTotalPixels / (width * height)),
    1,
  );
  return Math.min(dimScale, totalPixelScale, 1);
}

/** Draw `source` into a fresh canvas scaled by `scale`. Returns the source
 *  canvas itself when scale is ≥ 1 (no allocation overhead for the common
 *  case where the canvas already fits). */
function downscaleCanvas(
  source: HTMLCanvasElement,
  scale: number,
): HTMLCanvasElement {
  if (scale >= 1) return source;
  const target = document.createElement("canvas");
  target.width = Math.max(1, Math.floor(source.width * scale));
  target.height = Math.max(1, Math.floor(source.height * scale));
  const ctx = target.getContext("2d");
  if (!ctx) return source;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, target.width, target.height);
  return target;
}

/** Encode `canvas` to a PNG blob, downscaling iteratively if the encoded byte
 *  size still exceeds the snapshot envelope. Capped at five reductions —
 *  mostly a safety net since the dimension/pixel limits already keep most
 *  PNGs under the byte ceiling. Returns the resulting canvas/blob pair so
 *  callers can persist the actual emitted dimensions. */
async function encodeWithinSnapshotLimits(
  rawCanvas: HTMLCanvasElement,
): Promise<{ canvas: HTMLCanvasElement; blob: Blob | null }> {
  const initialScale = computeSnapshotScale(rawCanvas.width, rawCanvas.height);
  let canvas = downscaleCanvas(rawCanvas, initialScale);

  for (let attempt = 0; attempt < 5; attempt++) {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), "image/png");
    });
    if (!blob) return { canvas, blob: null };
    if (blob.size <= SNAPSHOT_MAX_SIZE_BYTES) return { canvas, blob };
    // Re-encoded blob still too large — shrink another 0.85× and retry.
    canvas = downscaleCanvas(canvas, 0.85);
  }
  // Final attempt — accept whatever fell out.
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((b) => resolve(b), "image/png");
  });
  return { canvas, blob };
}

export const ExportManagerExtension: ExtensionType = {
  setup: (di) => {
    di.add(ExportManager, [StdIdentifier]);
  },
};

function xywhArrayToObject(element: GfxBlockElementModel) {
  const [x, y, w, h] = deserializeXYWH(element.xywh);
  return { x, y, w, h };
}

type RootBlockComponent = BlockComponent & {
  viewportElement: HTMLElement;
  viewport: Viewport;
};

function getRootByEditorHost(
  editorHost: EditorHost,
): RootBlockComponent | null {
  const model = editorHost.store.root;
  if (!model) return null;
  const root = editorHost.view.getBlock(model.id);
  return root as RootBlockComponent | null;
}
