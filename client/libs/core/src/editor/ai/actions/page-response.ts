import { acceptSourceMindmap } from "./mindmap-source";
import { CodeBlockPreviewIdentifier } from "@virgultum/editor/blocks/code";
import { addSiblingImageBlocks } from "@virgultum/editor/blocks/image";
import {
  getSurfaceBlock,
  SurfaceBlockModel,
} from "@virgultum/editor/blocks/surface";
import { createTemplateJob } from "@virgultum/editor/gfx/template";
import { Bound, getCommonBound } from "@virgultum/editor/global/gfx";
import { type EditorHost, TextSelection } from "@virgultum/editor/std";
import {
  GfxBlockElementModel,
  type GfxModel,
  LayerManager,
} from "@virgultum/editor/std/gfx";
import { type BlockProps, Text } from "@virgultum/editor/store";
import * as Y from "yjs";

import { getAIPanelWidget } from "../utils/ai-widgets";
import type { MyoxusNode, AIContext } from "../utils/context";
import { insertAbove, insertBelow, replace } from "../utils/editor-actions";
import { preprocessHtml } from "../utils/html";
import { fetchImageToFile } from "../utils/image";
import { getSelections } from "../utils/selection-utils";

const PADDING = 100;

type Place = "after" | "before";

export async function pageResponseHandler<
  T extends keyof VirgultumPresets.AIActions,
>(id: T, host: EditorHost, ctx: AIContext, place: Place = "after") {
  switch (id) {
    case "brainstormMindmap":
      return acceptSourceMindmap(host, ctx, { kind: "page", place });
    case "makeItReal":
      responseToMakeItReal(host, ctx, place);
      break;
    case "createSlides":
      await responseToCreateSlides(host, ctx, place);
      break;
    case "createImage":
    case "filterImage":
    case "processImage":
      responseToCreateImage(host, place);
      break;
    default:
      await (place === "after"
        ? insertMarkdownBelow(host)
        : insertMarkdownAbove(host));
      break;
  }
  return;
}

function responseToMakeItReal(host: EditorHost, ctx: AIContext, place: Place) {
  const surface = getSurfaceBlock(host.store);
  const aiPanel = getAIPanelWidget(host);
  if (!aiPanel.answer || !surface) return;

  const { width, height } = ctx.get();
  const bound = getEdgelessContentBound(host);
  const x = bound ? bound.x + bound.w + PADDING * 2 : 0;
  const y = bound ? bound.y : 0;
  const htmlBound = new Bound(x, y + PADDING, width || 800, height || 600);
  const html = preprocessHtml(aiPanel.answer);
  host.store.transact(() => {
    const ifUseCodeBlock = host.std.getOptional(
      CodeBlockPreviewIdentifier("html"),
    );
    if (ifUseCodeBlock) {
      const note = host.store.addBlock(
        "myoxus:note",
        {
          xywh: htmlBound.serialize(),
        },
        host.store.root,
      );
      host.store.addBlock(
        "myoxus:code",
        { text: new Text(html), language: "html", preview: true },
        note,
      );
      const frameBound = expandBound(htmlBound, PADDING);
      addSurfaceRefBlock(host, frameBound, place);
    } else {
      host.store.addBlock(
        "myoxus:embed-html",
        {
          html,
          design: "ai:makeItReal", // as tag
          xywh: htmlBound.serialize(),
        },
        surface.id,
      );
      const frameBound = expandBound(htmlBound, PADDING);
      addSurfaceRefBlock(host, frameBound, place);
    }
  });
}

async function responseToCreateSlides(
  host: EditorHost,
  ctx: AIContext,
  place: Place,
) {
  const { contents, images = [] } = ctx.get();
  const surface = getSurfaceBlock(host.store);
  if (!contents || !surface) return;

  try {
    const frameIds: string[] = [];
    for (let i = 0; i < contents.length; i++) {
      const image = images[i];
      const content = contents[i];
      const job = createTemplateJob(host.std, "template");
      await Promise.all(
        image.map(({ id, url }) =>
          fetch(url)
            .then((res) => res.blob())
            .then((blob) => job.job.assets.set(id, blob)),
        ),
      );
      await job.insertTemplate(content);
      const frame = findFrameObject(content.blocks);
      frame && frameIds.push(frame.id);
    }
    const props = frameIds.map((id) => ({
      flavour: "myoxus:surface-ref",
      refFlavour: "myoxus:frame",
      reference: id,
      pageId: host.store.id,
      workspaceId: host.store.workspace.id,
    }));
    addSiblingBlocks(host, props, place);
  } catch (error) {
    console.error("Error creating slides:", error);
  }
}

export function responseToCreateImage(host: EditorHost, place: Place) {
  const aiPanel = getAIPanelWidget(host);
  const { answer } = aiPanel;
  if (!answer) return;
  const filename = "image";
  const imageProxy = host.std.clipboard.configs.get("imageProxy");

  fetchImageToFile(answer, filename, imageProxy)
    .then((file) => {
      if (!file) return;

      const targetModel = getTargetModel(host, place);
      if (!targetModel) return;

      return addSiblingImageBlocks(host.std, [file], targetModel, place);
    })
    .catch(console.error);
}

export async function replaceWithMarkdown(host: EditorHost) {
  const aiPanel = getAIPanelWidget(host);
  const { answer } = aiPanel;
  const selection = getSelection(host);
  if (!answer || !selection) return;

  const { textSelection, firstBlock, selectedModels } = selection;
  await replace(host, answer, firstBlock, selectedModels, textSelection);
}

async function insertMarkdownBelow(host: EditorHost) {
  const aiPanel = getAIPanelWidget(host);
  const { answer } = aiPanel;
  const selection = getSelection(host);
  if (!answer || !selection) return;

  const { lastBlock } = selection;
  await insertBelow(host, answer, lastBlock);
}

async function insertMarkdownAbove(host: EditorHost) {
  const aiPanel = getAIPanelWidget(host);
  const { answer } = aiPanel;
  const selection = getSelection(host);
  if (!answer || !selection) return;

  const { firstBlock } = selection;
  await insertAbove(host, answer, firstBlock);
}

function getSelection(host: EditorHost) {
  const textSelection = host.selection.find(TextSelection);
  const mode = textSelection ? "flat" : "highest";
  const { selectedBlocks } = getSelections(host, mode);
  if (!selectedBlocks) return;
  const length = selectedBlocks.length;
  const firstBlock = selectedBlocks[0];
  const lastBlock = selectedBlocks[length - 1];
  const selectedModels = selectedBlocks.map((block) => block.model);
  return {
    textSelection,
    selectedModels,
    firstBlock,
    lastBlock,
  };
}

function getEdgelessContentBound(host: EditorHost) {
  const surface = getSurfaceBlock(host.store);
  if (!surface) return;

  const elements = (
    host.store
      .getAllModels()
      .filter(
        (model) =>
          model instanceof GfxBlockElementModel &&
          (model.parent instanceof SurfaceBlockModel ||
            model.parent?.role === "root"),
      ) as GfxModel[]
  ).concat(surface.elementModels ?? []);
  const bounds = elements.map((element) => Bound.deserialize(element.xywh));
  const bound = getCommonBound(bounds);
  return bound;
}

function expandBound(bound: Bound, margin: number) {
  const x = bound.x - margin;
  const y = bound.y - margin;
  const w = bound.w + margin * 2;
  const h = bound.h + margin * 2;
  return new Bound(x, y, w, h);
}

function addSurfaceRefBlock(host: EditorHost, bound: Bound, place: Place) {
  const surface = getSurfaceBlock(host.store);
  if (!surface) return;
  const frame = host.store.addBlock(
    "myoxus:frame",
    {
      title: new Text(new Y.Text("Frame")),
      xywh: bound.serialize(),
      index: LayerManager.INITIAL_INDEX,
    },
    surface,
  );
  const props = {
    flavour: "myoxus:surface-ref",
    refFlavour: "myoxus:frame",
    reference: frame,
    pageId: host.store.id,
    workspaceId: host.store.workspace.id,
  };
  return addSiblingBlocks(host, [props], place);
}

function getTargetModel(host: EditorHost, place: Place) {
  const { selectedModels } = getSelection(host) || {};
  if (!selectedModels) return;
  return place === "before"
    ? selectedModels[0]
    : selectedModels[selectedModels.length - 1];
}

function addSiblingBlocks(
  host: EditorHost,
  props: Array<Partial<BlockProps>>,
  place: Place,
) {
  const targetModel = getTargetModel(host, place);
  if (!targetModel) return;
  return host.store.addSiblingBlocks(targetModel, props, place);
}

function findFrameObject(obj: MyoxusNode): MyoxusNode | null {
  if (obj.flavour === "myoxus:frame") {
    return obj;
  }

  if (obj.children) {
    for (const child of obj.children) {
      const result = findFrameObject(child);
      if (result) {
        return result;
      }
    }
  }

  return null;
}
