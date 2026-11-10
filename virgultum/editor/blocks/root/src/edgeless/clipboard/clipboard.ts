import { addAttachments } from "@virgultum/block-attachment";
import { EdgelessFrameManagerIdentifier } from "@virgultum/block-frame";
import { addImages } from "@virgultum/block-image";
import {
  CanvasRenderer,
  DefaultTool,
  EdgelessCRUDIdentifier,
  ExportManager,
  getSurfaceComponent,
} from "@virgultum/block-surface";
import { splitIntoLines } from "@virgultum/gfx-text";
import { DisposableGroup } from "@virgultum/global/disposable";
import { ErrorCode, VirgultumError } from "@virgultum/global/exceptions";
import {
  Bound,
  getCommonBound,
  type IBound,
  type IVec,
  Vec,
} from "@virgultum/global/gfx";
import {
  BookmarkStyles,
  DEFAULT_NOTE_HEIGHT,
  DEFAULT_NOTE_WIDTH,
  type EmbedCardStyle,
  FrameBlockModel,
  MAX_IMAGE_WIDTH,
  type ShapeElementModel,
} from "@virgultum/model";
import {
  ClipboardAdapter,
  decodeClipboardBlobs,
} from "@virgultum/shared/adapters";
import {
  CANVAS_EXPORT_IGNORE_TAGS,
  EMBED_CARD_HEIGHT,
  EMBED_CARD_WIDTH,
} from "@virgultum/shared/consts";
import {
  EmbedOptionProvider,
  ParseDocUrlProvider,
  TelemetryProvider,
} from "@virgultum/shared/services";
import {
  convertToPng,
  isInsidePageEditor,
  isTopLevelBlock,
  isUrlInClipboard,
  matchModels,
  referenceToNode,
} from "@virgultum/shared/utils";
import type {
  EditorHost,
  SurfaceSelection,
  UIEventStateContext,
} from "@virgultum/std";
import {
  compareLayer,
  getTopElements,
  GfxBlockElementModel,
  GfxControllerIdentifier,
  GfxPrimitiveElementModel,
  type SerializedElement,
} from "@virgultum/std/gfx";
import { type BlockSnapshot, type SliceSnapshot } from "@virgultum/store";
import * as Y from "yjs";

import { ClipboardConfigExtension } from "../../clipboard/clipboard-config.js";
import { PageClipboard } from "../../clipboard/index.js";
import { getSortedCloneElements } from "../utils/clone-utils.js";
import { isCanvasElementWithText, isImageBlock } from "../utils/query.js";
import { createElementsFromClipboardDataCommand } from "./command.js";
import {
  isPureFileInClipboard,
  prepareClipboardData,
  tryGetSvgFromClipboard,
} from "./utils.js";

const VIRGULTUM_SURFACE = "virgultum/surface";

const IMAGE_PADDING = 5; // for rotated shapes some padding is needed

interface CanvasExportOptions {
  dpr?: number;
  padding?: number;
  background?: string;
}

export class EdgelessClipboardController extends PageClipboard {
  static override key = "myoxus-edgeless-clipboard";

  private readonly _initEdgelessClipboard = () => {
    this._disposables.add(
      this.std.event.add("copy", (ctx) => {
        const { surfaceSelections, selectedIds } = this.selectionManager;

        if (selectedIds.length === 0) return false;

        this._onCopy(ctx, surfaceSelections).catch(console.error);
        return;
      }),
    );

    this._disposables.add(
      this.std.event.add("paste", (ctx) => {
        this._onPaste(ctx).catch(console.error);
      }),
    );

    this._disposables.add(
      this.std.event.add("cut", (ctx) => {
        this._onCut(ctx).catch(console.error);
      }),
    );
  };

  private readonly _onCopy = async (
    _context: UIEventStateContext,
    surfaceSelection: SurfaceSelection[],
  ) => {
    const event = _context.get("clipboardState").raw;
    event.preventDefault();

    const elements = getSortedCloneElements(
      this.selectionManager.selectedElements,
    );

    // when note active, handle copy like page mode
    if (surfaceSelection[0] && surfaceSelection[0].editing) {
      // use build-in copy handler in rich-text when copy in surface text element
      if (isCanvasElementWithText(elements[0])) return;
      this.onPageCopy(_context);
      return;
    }

    // Only when an image is selected, it can be pasted normally to page mode.
    if (elements.length === 1 && isImageBlock(elements[0])) {
      const element = elements[0];
      const sourceId = element.props.sourceId$.peek();
      if (!sourceId) return;

      await this.std.clipboard.writeToClipboard(async (items) => {
        const job = this.std.store.getTransformer();
        await job.assetsManager.readFromBlob(sourceId);

        let blob = job.assetsManager.getAssets().get(sourceId) ?? null;
        if (!blob) {
          return items;
        }

        let type = blob.type;
        let supported = false;

        try {
          supported = ClipboardItem?.supports(type) ?? false;
        } catch (err) {
          console.error(err);
        }

        // TODO(@fundon): when converting jpeg to png, image may become larger and exceed the limit.
        if (!supported) {
          type = "image/png";
          blob = await convertToPng(blob);
        }

        if (blob) {
          return {
            ...items,
            [`${type}`]: blob,
          };
        }

        return items;
      });

      return;
    }

    await this.std.clipboard.writeToClipboard(async (_items) => {
      const data = await prepareClipboardData(elements, this.std);
      return {
        ..._items,
        [VIRGULTUM_SURFACE]: JSON.stringify(data),
      };
    });
  };

  private readonly _onCut = async (_context: UIEventStateContext) => {
    const { surfaceSelections, selectedElements } = this.selectionManager;

    if (selectedElements.length === 0) return;

    const event = _context.get("clipboardState").event;
    event.preventDefault();

    await this._onCopy(_context, surfaceSelections);

    if (surfaceSelections[0]?.editing) {
      // use build-in cut handler in rich-text when cut in surface text element
      if (isCanvasElementWithText(selectedElements[0])) return;
      this.onPageCut(_context);
      return;
    }

    const elements = getSortedCloneElements(
      this.selectionManager.selectedElements,
    );
    if (
      this.doc.readonly ||
      elements.some((element) => this.doc.hasFixedText(element.id))
    )
      return;
    this.doc.transact(() => {
      this.crud.deleteElements(elements);
    });

    this.selectionManager.set({
      editing: false,
      elements: [],
    });
  };

  private readonly _onPaste = async (_context: UIEventStateContext) => {
    if (
      document.activeElement instanceof HTMLInputElement ||
      document.activeElement instanceof HTMLTextAreaElement
    ) {
      return;
    }
    const event = _context.get("clipboardState").raw;
    event.preventDefault();

    const { surfaceSelections, selectedElements } = this.selectionManager;

    if (surfaceSelections[0]?.editing) {
      // use build-in paste handler in rich-text when paste in surface text element
      if (isCanvasElementWithText(selectedElements[0])) return;
      this.onPagePaste(_context);
      return;
    }

    const data = event.clipboardData;
    if (!data) return;

    if (!this.surface) return;

    const lastMousePos = this.toolManager.lastMousePos$.peek();
    const point: IVec = [lastMousePos.x, lastMousePos.y];

    if (isPureFileInClipboard(data)) {
      const files = data.files;
      if (files.length === 0) return;

      const imageFiles: File[] = [],
        attachmentFiles: File[] = [];

      [...files].forEach((file) => {
        if (file.type.startsWith("image/")) {
          imageFiles.push(file);
        } else {
          attachmentFiles.push(file);
        }
      });

      // when only images in clipboard, add image-blocks else add all files as attachments
      if (attachmentFiles.length === 0) {
        await addImages(this.std, imageFiles, {
          point,
          maxWidth: MAX_IMAGE_WIDTH,
          shouldTransformPoint: false,
        });
      } else {
        await addAttachments(this.std, [...files], point, false);
      }

      this.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "canvas:paste",
        page: "whiteboard editor",
        module: "toolbar",
        segment: "toolbar",
        type: attachmentFiles.length === 0 ? "image" : "attachment",
      });

      return;
    }

    if (isUrlInClipboard(data)) {
      const url = data.getData("text/plain");
      const { x, y } = this.toolManager.lastMousePos$.peek();

      // Try to interpret the URL as a Myoxus document URL.
      const parseDocUrlService = this.std.getOptional(ParseDocUrlProvider);
      const docUrlInfo = parseDocUrlService?.parseDocUrl(url);
      const options: Record<string, unknown> = {};

      let flavour = "myoxus:bookmark";
      let style: EmbedCardStyle = BookmarkStyles[0];
      let isInternalLink = false;
      let isLinkedBlock = false;

      if (docUrlInfo) {
        const { docId: pageId, workspaceId, ...params } = docUrlInfo;

        flavour = "myoxus:embed-linked-doc";
        style = "vertical";

        isInternalLink = true;
        isLinkedBlock = referenceToNode({ pageId, params });
        options.pageId = pageId;
        options.workspaceId = workspaceId;
        if (params) options.params = params;
      } else {
        options.url = url;

        const embedOptions = this.std
          .get(EmbedOptionProvider)
          .getEmbedBlockOptions(url);
        if (embedOptions) {
          flavour = embedOptions.flavour;
          style = embedOptions.styles[0];
        }
      }

      const width = EMBED_CARD_WIDTH[style];
      const height = EMBED_CARD_HEIGHT[style];

      options.xywh = Bound.fromCenter(
        Vec.toVec({
          x,
          y,
        }),
        width,
        height,
      ).serialize();
      options.style = style;

      const id = this.crud.addBlock(flavour, options, this.surface.model.id);

      this.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
        control: "canvas:paste",
        page: "whiteboard editor",
        module: "toolbar",
        segment: "toolbar",
        type: flavour.split(":")[1],
      });

      this.std
        .getOptional(TelemetryProvider)
        ?.track(isInternalLink ? "LinkedDocCreated" : "Link", {
          page: "whiteboard editor",
          segment: "whiteboard",
          category: "pasted link",
          other: isInternalLink ? "existing doc" : "external link",
          type: isInternalLink ? (isLinkedBlock ? "block" : "doc") : "link",
        });

      this.selectionManager.set({
        editing: false,
        elements: [id],
      });

      return;
    }

    const svg = tryGetSvgFromClipboard(data);
    if (svg) {
      await addImages(this.std, [svg], { point, maxWidth: MAX_IMAGE_WIDTH });
      return;
    }
    let localFootnotes = false;
    try {
      // check for surface elements in clipboard
      const json = this.std.clipboard.readFromClipboard(data);
      const mayBeSurfaceDataJson = json[VIRGULTUM_SURFACE];
      if (mayBeSurfaceDataJson !== undefined) {
        const elementsRawData = JSON.parse(mayBeSurfaceDataJson);
        const { snapshot, blobs } = elementsRawData;
        const job = this.std.store.getTransformer();
        const map = job.assetsManager.getAssets();
        decodeClipboardBlobs(blobs, map);
        for (const blobId of map.keys()) {
          await job.assetsManager.writeToBlob(blobId);
        }
        await this._pasteShapesAndBlocks(snapshot);
        return;
      }
      // check for slice snapshot in clipboard
      const mayBeSliceDataJson = json[ClipboardAdapter.MIME];
      if (mayBeSliceDataJson === undefined) return;
      const clipData = JSON.parse(mayBeSliceDataJson);
      const sliceSnapShot = clipData?.snapshot as SliceSnapshot;
      localFootnotes = this.std.clipboard.containsFootnotes(
        sliceSnapShot.content,
      );
      await this._pasteTextContentAsNote(
        sliceSnapShot.content,
        localFootnotes ? event : undefined,
      );
    } catch (error) {
      if (localFootnotes) throw error;
      // if it is not parsable
      await this._pasteTextContentAsNote(data.getData("text/plain"));
    }
  };

  private get _exportManager() {
    return this.std.getOptional(ExportManager);
  }

  private get doc() {
    return this.std.store;
  }

  private get selectionManager() {
    return this.gfx.selection;
  }

  private get surface() {
    return getSurfaceComponent(this.std);
  }

  private get frame() {
    return this.std.get(EdgelessFrameManagerIdentifier);
  }

  private get gfx() {
    return this.std.get(GfxControllerIdentifier);
  }

  private get crud() {
    return this.std.get(EdgelessCRUDIdentifier);
  }

  private get toolManager() {
    return this.gfx.tool;
  }

  private _checkCanContinueToCanvas(
    host: EditorHost,
    pathName: string,
    editorMode: boolean,
  ) {
    if (
      location.pathname !== pathName ||
      isInsidePageEditor(host) !== editorMode
    ) {
      throw new Error("Unable to export content to canvas");
    }
  }

  private async _edgelessToCanvas(
    bound: IBound,
    nodes?: GfxBlockElementModel[],
    canvasElements: GfxPrimitiveElementModel[] = [],
    {
      background,
      padding = IMAGE_PADDING,
      dpr = window.devicePixelRatio || 1,
    }: CanvasExportOptions = {},
  ): Promise<HTMLCanvasElement | undefined> {
    const host = this.std.host;
    const rootModel = this.doc.root;
    if (!rootModel) return;

    const html2canvas = (await import("html2canvas")).default;
    if (!(html2canvas instanceof Function)) return;
    if (!this.surface) return;

    const pathname = location.pathname;
    const editorMode = isInsidePageEditor(host);

    const canvas = document.createElement("canvas");
    canvas.width = (bound.w + padding * 2) * dpr;
    canvas.height = (bound.h + padding * 2) * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    ctx.scale(dpr, dpr);

    const replaceImgSrcWithSvg = this._exportManager?.replaceImgSrcWithSvg;

    const imageProxy = host.std.clipboard.configs.get("imageProxy");
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

      onclone: async function (documentClone: Document, element: HTMLElement) {
        // html2canvas can't support transform feature
        element.style.setProperty("transform", "none");
        const layer = documentClone.querySelector(".myoxus-edgeless-layer");
        if (layer && layer instanceof HTMLElement) {
          layer.style.setProperty("transform", "none");
        }

        const boxShadowElements = documentClone.querySelectorAll(
          "[style*='box-shadow']",
        );
        boxShadowElements.forEach(function (element) {
          if (element instanceof HTMLElement) {
            element.style.setProperty("box-shadow", "none");
          }
        });
        await replaceImgSrcWithSvg?.(element);
      },
      backgroundColor: "transparent",
      useCORS: imageProxy ? false : true,
      proxy: imageProxy,
    };

    const _drawTopLevelBlock = async (
      block: GfxBlockElementModel,
      isInFrame = false,
    ) => {
      const blockComponent = this.std.view.getBlock(block.id);
      if (!blockComponent) {
        throw new VirgultumError(
          ErrorCode.EdgelessExportError,
          "Could not find edgeless block component.",
        );
      }

      const blockBound = Bound.deserialize(block.xywh);
      const canvasData = await html2canvas(
        blockComponent as HTMLElement,
        html2canvasOption,
      );
      ctx.drawImage(
        canvasData,
        blockBound.x - bound.x + padding,
        blockBound.y - bound.y + padding,
        blockBound.w,
        isInFrame
          ? (blockBound.w / canvasData.width) * canvasData.height
          : blockBound.h,
      );
    };

    const nodeElements =
      nodes ??
      (this.gfx.getElementsByBound(bound, {
        type: "block",
      }) as GfxBlockElementModel[]);
    for (const nodeElement of nodeElements) {
      await _drawTopLevelBlock(nodeElement);

      if (matchModels(nodeElement, [FrameBlockModel])) {
        const blocksInsideFrame: GfxBlockElementModel[] = [];
        this.frame
          .getElementsInFrameBound(nodeElement, false)
          .forEach((ele) => {
            if (isTopLevelBlock(ele)) {
              blocksInsideFrame.push(ele as GfxBlockElementModel);
            } else {
              canvasElements.push(ele as GfxPrimitiveElementModel);
            }
          });

        // oxlint-disable-next-line typescript/prefer-for-of
        for (let i = 0; i < blocksInsideFrame.length; i++) {
          const element = blocksInsideFrame[i];
          await _drawTopLevelBlock(element, true);
        }
      }

      this._checkCanContinueToCanvas(host, pathname, editorMode);
    }

    // TODO: handle DOM renderer case for clipboard image generation
    if (!(this.surface.renderer instanceof CanvasRenderer)) {
      console.warn(
        "Skipping canvas generation for clipboard: DOM renderer active.",
      );
      return canvas; // Return the empty canvas or handle error
    }

    const surfaceCanvas = this.surface.renderer.getCanvasByBound(
      bound,
      canvasElements,
    );
    ctx.drawImage(surfaceCanvas, padding, padding, bound.w, bound.h);

    return canvas;
  }

  private _emitSelectionChangeAfterPaste(
    canvasElementIds: string[],
    blockIds: string[],
  ) {
    const newSelected = [
      ...canvasElementIds,
      ...blockIds.filter((id) => {
        return isTopLevelBlock(this.doc.getModelById(id));
      }),
    ];

    this.selectionManager.set({
      editing: false,
      // Compound children remain owned by their pasted top-level object;
      // selecting both exposes generic multiselection/group actions.
      elements: getTopElements(
        newSelected.flatMap((id) => {
          const model = this.gfx.getElementById(id);
          return model instanceof GfxBlockElementModel ||
            model instanceof GfxPrimitiveElementModel
            ? [model]
            : [];
        }),
      ).map((model) => model.id),
    });
  }

  private async _pasteShapesAndBlocks(
    elementsRawData: (SerializedElement | BlockSnapshot)[],
  ) {
    const [_, { createdElementsPromise }] = this.std.command.exec(
      createElementsFromClipboardDataCommand,
      {
        elementsRawData,
      },
    );
    if (!createdElementsPromise) return;
    const { canvasElements, blockModels } = await createdElementsPromise;
    this._emitSelectionChangeAfterPaste(
      canvasElements.map((ele) => ele.id),
      blockModels.map((block) => block.id),
    );
  }

  private async _pasteTextContentAsNote(
    content: BlockSnapshot[] | string,
    footnoteEvent?: ClipboardEvent,
  ) {
    if (content === "") {
      return;
    }

    const { x, y } = this.toolManager.lastMousePos$.peek();

    const noteProps = {
      xywh: new Bound(
        x,
        y,
        DEFAULT_NOTE_WIDTH,
        DEFAULT_NOTE_HEIGHT,
      ).serialize(),
    };

    const createNote = () =>
      this.crud.addBlock("myoxus:note", noteProps, this.doc.root!.id);
    let noteId: string;
    if (footnoteEvent) {
      // Native local targets and their complete bodies are validated/remapped by
      // the ordinary adapter before creating the destination canvas note.
      let created: string | undefined;
      await this.std.clipboard.paste(
        footnoteEvent,
        this.doc,
        undefined,
        undefined,
        () => ({ parent: (created = createNote()) }),
      );
      if (!created) return;
      noteId = created;
    } else {
      noteId = createNote();
    }

    this.std.getOptional(TelemetryProvider)?.track("CanvasElementAdded", {
      control: "canvas:paste",
      page: "whiteboard editor",
      module: "toolbar",
      segment: "toolbar",
      type: "note",
    });

    if (!footnoteEvent && typeof content === "string") {
      splitIntoLines(content).forEach((line, idx) => {
        this.crud.addBlock(
          "myoxus:paragraph",
          { text: new Y.Text(line) },
          noteId,
          idx,
        );
      });
    } else if (!footnoteEvent && typeof content !== "string") {
      await this.std.clipboard.pasteBlockSnapshots(
        content.flatMap((block) =>
          block.flavour === "myoxus:note" ? block.children : [block],
        ),
        this.doc,
        noteId,
      );
    }

    this.gfx.selection.set({
      elements: [noteId],
      editing: false,
    });
    this.gfx.tool.setTool(DefaultTool);
  }

  copy() {
    document.dispatchEvent(
      new Event("copy", {
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  override mounted() {
    if (this._disposables.disposed) {
      this._disposables = new DisposableGroup();
    }
    // Surface toolbar duplication uses the same internal slice pipeline as
    // Page. Keep it available independently of native clipboard access.
    this._init();
    const clipboardConfig = this.std.getOptional(
      ClipboardConfigExtension.identifier,
    );
    const httpFallback = clipboardConfig?.httpFallback ?? false;
    if (!navigator.clipboard && !httpFallback) {
      console.debug(
        "navigator.clipboard is not available. Enable clipboardHttpFallback in admin settings to use execCommand fallback over HTTP.",
      );
      return;
    }
    this._initEdgelessClipboard();
  }

  async toCanvas(
    blocks: GfxBlockElementModel[],
    shapes: ShapeElementModel[],
    options?: CanvasExportOptions,
  ) {
    blocks.sort(compareLayer);
    shapes.sort(compareLayer);

    const bounds: IBound[] = [];
    blocks.forEach((block) => {
      bounds.push(Bound.deserialize(block.xywh));
    });
    shapes.forEach((shape) => {
      bounds.push(shape.elementBound);
    });
    const bound = getCommonBound(bounds);
    if (!bound) {
      console.error("bound not exist");
      return;
    }

    const canvas = await this._edgelessToCanvas(bound, blocks, shapes, options);
    return canvas;
  }
}
