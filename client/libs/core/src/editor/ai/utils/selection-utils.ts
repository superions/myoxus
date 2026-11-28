// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import {
  EdgelessClipboardController,
  splitElements,
} from "@virgultum/editor/blocks/root";
import {
  getSurfaceBlock,
  type SurfaceBlockComponent,
} from "@virgultum/editor/blocks/surface";
import { DatabaseBlockModel, ImageBlockModel } from "@virgultum/editor/model";
import {
  getBlockSelectionsCommand,
  getImageSelectionsCommand,
  getSelectedBlocksCommand,
  getSelectedModelsCommand,
  getTextSelectionCommand,
} from "@virgultum/editor/shared/commands";
import { matchModels } from "@virgultum/editor/shared/utils";
import { type EditorHost, TextSelection } from "@virgultum/editor/std";
import {
  GfxControllerIdentifier,
  type GfxModel,
} from "@virgultum/editor/std/gfx";
import {
  type BlockModel,
  type DraftModel,
  Slice,
  toDraftModel,
} from "@virgultum/editor/store";

import { getContentFromSlice } from "../../utils";
import type { CopilotTool } from "../tool/copilot-tool";
import { isAttachment } from "./attachment";
import { getEdgelessCopilotWidget } from "./get-edgeless-copilot-widget";

export async function elementsToCanvas(
  host: EditorHost,
  elements: GfxModel[],
): Promise<HTMLCanvasElement | undefined> {
  const { notes, frames, shapes, images, edgelessTexts, embedSyncedDocs } =
    splitElements(elements);

  const blocks = [
    ...notes,
    ...frames,
    ...images,
    ...edgelessTexts,
    ...embedSyncedDocs,
  ];
  if (blocks.length === 0 && shapes.length === 0) return;

  try {
    const canvas = await host.std
      .get(EdgelessClipboardController)
      .toCanvas(blocks, shapes);
    return canvas ?? undefined;
  } catch (err) {
    console.error("elementsToCanvas error", err);
    return;
  }
}

export function selectedToCanvas(host: EditorHost) {
  const gfx = host.std.get(GfxControllerIdentifier);
  return elementsToCanvas(host, gfx.selection.selectedElements);
}

export function allToCanvas(host: EditorHost) {
  const gfx = host.std.get(GfxControllerIdentifier);
  return elementsToCanvas(host, gfx.gfxElements);
}

export function getSelectedModels(host: EditorHost) {
  const [, ctx] = host.std.command.exec(getSelectedModelsCommand, {
    types: ["block", "text"],
  });
  return ctx.selectedModels;
}

export function traverse(model: DraftModel, pool: DraftModel[]): void {
  const keepChildren =
    model.flavour === "myoxus:database"
      ? model.children
      : model.children.filter((child) =>
          pool.some((entry) => entry.id === child.id),
        );

  for (const child of keepChildren) {
    const index = pool.findIndex((entry) => entry.id === child.id);
    if (index >= 0) {
      pool.splice(index, 1);
    }
    traverse(child, pool);
  }
  model.children = keepChildren;
}

export async function getTextContentFromBlockModels(
  host: EditorHost,
  models: BlockModel[],
  format: "markdown" | "plain-text" = "markdown",
): Promise<string> {
  const textModels = models.filter(
    (model) => !matchModels(model, [ImageBlockModel, DatabaseBlockModel]),
  );
  const drafts = textModels.map(toDraftModel);
  for (const draft of drafts) {
    traverse(draft, drafts);
  }
  const slice = Slice.fromModels(host.std.store, drafts);
  return getContentFromSlice(host, slice, format);
}

export async function getSelectedTextContent(
  host: EditorHost,
  format: "markdown" | "plain-text" = "markdown",
): Promise<string> {
  const selected = getSelectedModels(host);
  if (!selected) return "";
  return getTextContentFromBlockModels(host, selected, format);
}

export async function selectAboveBlocks(
  host: EditorHost,
  limit = 10,
): Promise<string> {
  const currentSelected = getSelectedModels(host);
  if (!currentSelected?.length) return "";

  const targetLeaf = currentSelected[currentSelected.length - 1];
  let note: BlockModel | null = targetLeaf;
  let topChild: BlockModel | null = null;
  while (note && note.flavour !== "myoxus:note") {
    topChild = note;
    note = host.store.getParent(note);
  }
  if (!note || !topChild) return "";

  const endIdx = note.children.indexOf(topChild) + 1;
  const startIdx = Math.max(0, endIdx - limit);
  const firstBlock = note.children[startIdx];

  const collected: BlockModel[] = [];
  let reachedTarget = false;
  const collectUntilLeaf = (node: BlockModel) => {
    if (reachedTarget) return;
    collected.push(node);
    if (node === targetLeaf) {
      reachedTarget = true;
      return;
    }
    for (const child of node.children) {
      collectUntilLeaf(child);
    }
  };
  for (const root of note.children.slice(startIdx, endIdx)) {
    collectUntilLeaf(root);
  }

  const { selection } = host;
  selection.set([
    selection.create(TextSelection, {
      from: {
        blockId: firstBlock.id,
        index: 0,
        length: firstBlock.text?.length ?? 0,
      },
      to: {
        blockId: targetLeaf.id,
        index: 0,
        length: selection.find(TextSelection)?.from.index ?? 0,
      },
    }),
  ]);

  return getTextContentFromBlockModels(host, collected);
}

export function getSurfaceElementFromEditor(
  host: EditorHost,
): SurfaceBlockComponent | null {
  const surface = getSurfaceBlock(host.store);
  if (!surface) return null;
  return host.querySelector(
    `myoxus-surface[data-block-id="${surface.id}"]`,
  ) as SurfaceBlockComponent | null;
}

export function getSelections(
  host: EditorHost,
  mode: "flat" | "highest" = "flat",
) {
  const [, data] = host.command
    .chain()
    .tryAll((chain) => [
      chain.pipe(getTextSelectionCommand),
      chain.pipe(getBlockSelectionsCommand),
      chain.pipe(getImageSelectionsCommand),
    ])
    .pipe(getSelectedBlocksCommand, {
      types: ["text", "block", "image"],
      mode,
    })
    .run();
  return data;
}

export async function getSelectedImagesAsBlobs(
  host: EditorHost,
): Promise<File[]> {
  const [, data] = host.command
    .chain()
    .tryAll((chain) => [
      chain.pipe(getTextSelectionCommand),
      chain.pipe(getBlockSelectionsCommand),
      chain.pipe(getImageSelectionsCommand),
    ])
    .pipe(getSelectedBlocksCommand, { types: ["block", "image"] })
    .run();

  const files = await Promise.all(
    (data.selectedBlocks ?? []).map(async (block) => {
      const sourceId = (block.model as ImageBlockModel).props.sourceId;
      if (!sourceId) return null;
      const blob = await host.store.blobSync.get(sourceId);
      return blob ? new File([blob], sourceId) : null;
    }),
  );

  return files.filter((file): file is File => file !== null);
}

export async function getSelectedAttachments(
  host: EditorHost,
): Promise<Array<{ sourceId: string; name: string }>> {
  const [, data] = host.command.exec(getSelectedBlocksCommand, {
    types: ["block"],
  });

  const attachments: Array<{ sourceId: string; name: string }> = [];
  for (const block of data.selectedBlocks ?? []) {
    if (isAttachment(block.model)) {
      const { sourceId, name } = block.model.props;
      if (sourceId && name) {
        attachments.push({ sourceId, name });
      }
    }
  }
  return attachments;
}

export function getSelectedNoteAnchor(host: EditorHost, id: string) {
  return host.querySelector(`myoxus-edgeless-note[data-block-id="${id}"]`);
}

export function getCopilotSelectedElems(host: EditorHost): GfxModel[] {
  const gfx = host.std.get(GfxControllerIdentifier);
  const copilotWidget = getEdgelessCopilotWidget(host);
  if (copilotWidget.visible) {
    const activeTool = gfx.tool.currentTool$.peek() as CopilotTool;
    return activeTool?.selectedElements ?? [];
  }
  return gfx.selection.selectedElements;
}

export async function imageCustomInput(host: EditorHost) {
  const selected = getCopilotSelectedElems(host);
  if (selected.length !== 1) return;

  const target = selected[0];
  if (!(target instanceof ImageBlockModel) || !target.props.sourceId) return;

  const blob = await host.store.blobSync.get(target.props.sourceId);
  if (!blob) return;
  return { attachments: [blob] };
}
