// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { CodeBlockPreviewIdentifier } from "@virgultum/editor/blocks/code";
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

import { getAIPanelController } from "../utils/ai-widgets";
import type { AIContext, MyoxusNode } from "../utils/context";
import { insertAbove, insertBelow, replace } from "../utils/editor-actions";
import { preprocessHtml } from "../utils/html";
import { getSelections } from "../utils/selection-utils";
import { acceptSourceMindmap } from "./mindmap-source";

const SURFACE_PADDING = 100;

type InsertionSide = "after" | "before";

function resolveSelectionTargets(host: EditorHost) {
  const textSelection = host.selection.find(TextSelection);
  const mode = textSelection ? "flat" : "highest";
  const { selectedBlocks } = getSelections(host, mode);
  if (!selectedBlocks?.length) return null;

  return {
    textSelection,
    firstBlock: selectedBlocks[0],
    lastBlock: selectedBlocks[selectedBlocks.length - 1],
    selectedModels: selectedBlocks.map((block) => block.model),
  };
}

function appendSiblingBlocks(
  host: EditorHost,
  props: Array<Partial<BlockProps>>,
  side: InsertionSide,
) {
  const selection = resolveSelectionTargets(host);
  if (!selection) return;
  const anchor =
    side === "before"
      ? selection.selectedModels[0]
      : selection.selectedModels[selection.selectedModels.length - 1];
  return host.store.addSiblingBlocks(anchor, props, side);
}

function computeCanvasContentBound(host: EditorHost) {
  const surface = getSurfaceBlock(host.store);
  if (!surface) return null;

  const surfaceBlocks = host.store
    .getAllModels()
    .filter(
      (model): model is GfxBlockElementModel =>
        model instanceof GfxBlockElementModel &&
        (model.parent instanceof SurfaceBlockModel ||
          model.parent?.role === "root"),
    );
  const allElements: GfxModel[] = [
    ...surfaceBlocks,
    ...(surface.elementModels ?? []),
  ];
  return getCommonBound(allElements.map((el) => Bound.deserialize(el.xywh)));
}

function addFrameSurfaceRef(
  host: EditorHost,
  bound: Bound,
  side: InsertionSide,
) {
  const surface = getSurfaceBlock(host.store);
  if (!surface) return;

  const frameId = host.store.addBlock(
    "myoxus:frame",
    {
      title: new Text(new Y.Text("Frame")),
      xywh: bound.serialize(),
      index: LayerManager.INITIAL_INDEX,
    },
    surface,
  );
  return appendSiblingBlocks(
    host,
    [
      {
        flavour: "myoxus:surface-ref",
        refFlavour: "myoxus:frame",
        reference: frameId,
        pageId: host.store.id,
        workspaceId: host.store.workspace.id,
      },
    ],
    side,
  );
}

function findFrameNode(root: MyoxusNode): MyoxusNode | null {
  if (root.flavour === "myoxus:frame") return root;
  for (const child of root.children ?? []) {
    const match = findFrameNode(child);
    if (match) return match;
  }
  return null;
}

function insertMakeItRealArtifact(
  host: EditorHost,
  ctx: AIContext,
  side: InsertionSide,
) {
  const surface = getSurfaceBlock(host.store);
  const panel = getAIPanelController(host);
  if (!panel.answer || !surface) return;

  const { width, height } = ctx.get();
  const contentBound = computeCanvasContentBound(host);
  const x = contentBound
    ? contentBound.x + contentBound.w + SURFACE_PADDING * 2
    : 0;
  const y = contentBound ? contentBound.y : 0;
  const htmlBound = new Bound(
    x,
    y + SURFACE_PADDING,
    width || 800,
    height || 600,
  );
  const html = preprocessHtml(panel.answer);
  const frameBound = new Bound(
    htmlBound.x - SURFACE_PADDING,
    htmlBound.y - SURFACE_PADDING,
    htmlBound.w + SURFACE_PADDING * 2,
    htmlBound.h + SURFACE_PADDING * 2,
  );

  host.store.transact(() => {
    const useHtmlCodeBlock = host.std.getOptional(
      CodeBlockPreviewIdentifier("html"),
    );
    if (useHtmlCodeBlock) {
      const note = host.store.addBlock(
        "myoxus:note",
        { xywh: htmlBound.serialize() },
        host.store.root,
      );
      host.store.addBlock(
        "myoxus:code",
        { text: new Text(html), language: "html", preview: true },
        note,
      );
    } else {
      host.store.addBlock(
        "myoxus:embed-html",
        {
          html,
          design: "ai:makeItReal",
          xywh: htmlBound.serialize(),
        },
        surface.id,
      );
    }
    addFrameSurfaceRef(host, frameBound, side);
  });
}

async function insertGeneratedSlides(
  host: EditorHost,
  ctx: AIContext,
  side: InsertionSide,
) {
  const { contents, images = [] } = ctx.get();
  const surface = getSurfaceBlock(host.store);
  if (!contents?.length || !surface) return;

  try {
    const frameIds: string[] = [];
    for (let i = 0; i < contents.length; i++) {
      const slideTemplate = contents[i];
      const slideImages = images[i] ?? [];
      const job = createTemplateJob(host.std, "template");
      await Promise.all(
        slideImages.map(async ({ id, url }) => {
          const blob = await fetch(url).then((res) => res.blob());
          job.job.assets.set(id, blob);
        }),
      );
      await job.insertTemplate(slideTemplate);
      const frame = findFrameNode(slideTemplate.blocks);
      if (frame) frameIds.push(frame.id);
    }

    appendSiblingBlocks(
      host,
      frameIds.map((reference) => ({
        flavour: "myoxus:surface-ref",
        refFlavour: "myoxus:frame",
        reference,
        pageId: host.store.id,
        workspaceId: host.store.workspace.id,
      })),
      side,
    );
  } catch (err) {
    console.error("Error creating slides:", err);
  }
}

export async function replaceWithMarkdown(host: EditorHost): Promise<void> {
  const { answer } = getAIPanelController(host);
  const targets = resolveSelectionTargets(host);
  if (!answer || !targets) return;

  await replace(
    host,
    answer,
    targets.firstBlock,
    targets.selectedModels,
    targets.textSelection,
  );
}

export async function pageResponseHandler<
  K extends keyof VirgultumPresets.AIActions,
>(id: K, host: EditorHost, ctx: AIContext, side: InsertionSide = "after") {
  switch (id) {
    case "brainstormMindmap":
      return acceptSourceMindmap(host, ctx, { kind: "page", place: side });
    case "makeItReal":
      insertMakeItRealArtifact(host, ctx, side);
      return;
    case "createSlides":
      await insertGeneratedSlides(host, ctx, side);
      return;
    default: {
      const { answer } = getAIPanelController(host);
      const targets = resolveSelectionTargets(host);
      if (!answer || !targets) return;
      if (side === "after") {
        await insertBelow(host, answer, targets.lastBlock);
      } else {
        await insertAbove(host, answer, targets.firstBlock);
      }
      return;
    }
  }
}
