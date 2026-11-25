// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

import type { FrameworkProvider } from "@myoxus/infra";
import { notify } from "@myoxus/ui-facade";
import {
  Text,
  type BlockModel,
  type DeltaInsert,
  type Store,
} from "@virgultum/core/store";
import { isValidUrl, normalizeUrl, readImageSize } from "@virgultum/core/utils";
import {
  loomUrlRegex,
  parseGitForgeUrl,
  youtubeUrlRegex,
} from "@virgultum/embeds/provider-data";

import { attachmentFileLimit } from "../../view-extensions/editor-view/file-size-limit";
import { resolveInsertParent } from "./page-slash-registry";
import { restorePageRange } from "./plain-page-input";

const FIGMA_URL_RE =
  /^https:\/\/(?:[\w.-]+\.)?figma\.com\/(?:file|proto|design|board|deck|slides)\//i;

export function embedFlavourForUrl(url: string): string {
  if (youtubeUrlRegex.test(url)) return "myoxus:embed-youtube";
  if (loomUrlRegex.test(url)) return "myoxus:embed-loom";
  if (FIGMA_URL_RE.test(url)) return "myoxus:embed-figma";
  if (parseGitForgeUrl(url)) return "myoxus:embed-github";
  return "myoxus:bookmark";
}

export function downloadBlobUrl(url: string, filename: string) {
  const link = document.createElement("a");
  link.download = filename;
  link.href = url;
  link.click();
}

export function deletePageBlock(model: BlockModel) {
  const store = model.store;
  if (store.readonly || store.getModelById(model.id) !== model) return false;
  store.captureSync();
  store.deleteBlock(model);
  store.captureSync();
  return true;
}

function cloneBlockValue(value: unknown): unknown {
  if (value instanceof Text) {
    return new Text(value.toDelta() as DeltaInsert[]);
  }
  if (Array.isArray(value)) {
    return value.map((item) => cloneBlockValue(item));
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const cloned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        cloned[k] = cloneBlockValue(v);
      }
      return cloned;
    }
  }
  return value;
}

function cloneBlockProps(model: BlockModel): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    model.props as Record<string, unknown>,
  )) {
    if (key.endsWith("$")) continue;
    if (key === "text" && model.text) {
      props.text = new Text(model.text.toDelta() as DeltaInsert[]);
    } else if (value !== undefined) {
      props[key] = cloneBlockValue(value);
    }
  }
  return props;
}

function cloneBlockSubtree(
  store: Store,
  source: BlockModel,
  parent: BlockModel,
  index: number,
): string {
  const createdId = store.addBlock(
    source.flavour,
    cloneBlockProps(source),
    parent,
    index,
  );
  const createdModel = store.getModelById(createdId);
  if (createdModel && source.children.length) {
    source.children.forEach((child, childIndex) => {
      cloneBlockSubtree(store, child, createdModel, childIndex);
    });
  }
  return createdId;
}

export function duplicatePageBlock(model: BlockModel): string | null {
  const store = model.store;
  if (store.readonly || store.getModelById(model.id) !== model) return null;
  const parent = store.getParent(model);
  if (!parent) return null;
  const index = parent.children.indexOf(model);
  if (index < 0) return null;
  let created: string | null = null;
  store.captureSync();
  store.transact(() => {
    created = cloneBlockSubtree(store, model, parent, index + 1);
  });
  store.captureSync();
  return created;
}

/**
 * Keyboard navigation / removal / Enter-insert for focused atomic blocks
 * (images, attachments, bookmarks, embeds, dividers) in Page mode.
 */
export function leaveAtomicPageBlock(
  root: HTMLElement | null,
  model: BlockModel,
  direction: -1 | 1,
  remove: boolean,
  insertAfter = false,
) {
  const store = model.store;
  const parent = store.getParent(model);
  if (!parent || store.getModelById(model.id) !== model) return;
  if ((remove || insertAfter) && store.readonly) return;
  const siblings = parent.children;
  const index = siblings.indexOf(model);
  if (index < 0) return;
  let next: BlockModel | undefined =
    siblings[index + direction] ?? siblings[index - direction];
  let targetId = next?.id;
  if (remove || insertAfter) {
    store.captureSync();
    store.transact(() => {
      if (remove) store.deleteBlock(model);
      if (insertAfter || !next) {
        targetId = store.addBlock(
          "myoxus:paragraph",
          {},
          parent,
          index + (insertAfter ? 1 : 0),
        );
        next = undefined;
      }
    });
    store.captureSync();
  }
  if (!root || !targetId) return;
  const targetModel = store.getModelById(targetId);
  requestAnimationFrame(() => {
    if (!root.isConnected) return;
    if (targetModel?.text) {
      const point = {
        id: targetId!,
        offset:
          next && next === siblings[index - 1]
            ? (targetModel.text.length ?? 0)
            : 0,
      };
      root
        .querySelector<HTMLElement>("[data-page-body]")
        ?.focus({ preventScroll: true });
      restorePageRange(root, { anchor: point, focus: point });
    } else {
      root
        .querySelector<HTMLElement>(
          `[data-block-id="${CSS.escape(targetId!)}"]`,
        )
        ?.focus({ preventScroll: true });
    }
  });
}

export async function copyOrCutPageBlock(
  model: BlockModel,
  action: "copy" | "cut",
  framework: FrameworkProvider,
  signal: AbortSignal,
) {
  const { copyPageBlock } = await import("./page-block-copy");
  await copyPageBlock(model, framework, signal);
  if (action === "cut" && !signal.aborted) {
    deletePageBlock(model);
  }
}

/**
 * Paste files, URLs, or plain text directly after a focused atomic Page block
 * without handing off to VirgultumEditor.
 */
export async function pasteAfterPageBlock(
  model: BlockModel,
  data: DataTransfer,
): Promise<boolean> {
  const store = model.store;
  if (store.readonly || store.getModelById(model.id) !== model) return false;
  const files = Array.from(data.files ?? []);
  if (files.length) {
    const prepared: Array<{
      flavour: string;
      props: Record<string, unknown>;
    }> = [];
    for (const file of files) {
      if (file.size > attachmentFileLimit.maxFileSize) {
        attachmentFileLimit.onOverFileSize();
        continue;
      }
      if (
        file.type.startsWith("image/") &&
        store.schema.flavourSchemaMap.has("myoxus:image")
      ) {
        const [imageSize, sourceId] = await Promise.all([
          readImageSize(file),
          store.blobSync.set(file),
        ]);
        prepared.push({
          flavour: "myoxus:image",
          props: { size: file.size, sourceId, ...imageSize },
        });
      } else if (store.schema.flavourSchemaMap.has("myoxus:attachment")) {
        const sourceId = await store.blobSync.set(file);
        prepared.push({
          flavour: "myoxus:attachment",
          props: {
            name: file.name,
            size: file.size,
            type: file.type || "application/octet-stream",
            sourceId,
          },
        });
      }
    }
    if (!prepared.length) return true;
    if (store.readonly || store.getModelById(model.id) !== model) return false;
    const target = resolveInsertParent(store, model, prepared[0].flavour);
    if (!target) return false;
    store.captureSync();
    store.transact(() => {
      prepared.forEach((entry, offset) => {
        store.addBlock(
          entry.flavour,
          entry.props,
          target.parent,
          target.index + 1 + offset,
        );
      });
    });
    store.captureSync();
    return true;
  }

  const rawText = data.getData("text/plain");
  if (!rawText) return false;
  const trimmed = rawText.trim();
  if (trimmed && !trimmed.includes("\n") && isValidUrl(trimmed)) {
    const normalized = normalizeUrl(trimmed);
    const flavour = embedFlavourForUrl(normalized);
    const resolvedFlavour = store.schema.flavourSchemaMap.has(flavour)
      ? flavour
      : "myoxus:bookmark";
    const target = resolveInsertParent(store, model, resolvedFlavour);
    if (target) {
      store.captureSync();
      store.transact(() => {
        store.addBlock(
          resolvedFlavour,
          { url: normalized },
          target.parent,
          target.index + 1,
        );
      });
      store.captureSync();
      return true;
    }
  }

  const lines = rawText.replaceAll("\r\n", "\n").split("\n");
  const target = resolveInsertParent(store, model, "myoxus:paragraph");
  if (!target) return false;
  store.captureSync();
  store.transact(() => {
    lines.forEach((line, i) => {
      store.addBlock(
        "myoxus:paragraph",
        { text: new Text(line) },
        target.parent,
        target.index + 1 + i,
      );
    });
  });
  store.captureSync();
  return true;
}

/**
 * Convert an inline link run into a Bookmark / Embed card block in one atomic
 * Store transaction without handing off to VirgultumEditor.
 */
export function convertLinkToEmbedCard(
  store: Store,
  model: BlockModel,
  start: number,
  end: number,
  rawUrl: string,
): string | null {
  if (
    store.readonly ||
    store.hasFixedText(model) ||
    store.getModelById(model.id) !== model ||
    !model.text
  )
    return null;
  const url = normalizeUrl(rawUrl.trim());
  if (!isValidUrl(url)) return null;
  const preferred = embedFlavourForUrl(url);
  const flavour = store.schema.flavourSchemaMap.has(preferred)
    ? preferred
    : "myoxus:bookmark";
  const target = resolveInsertParent(store, model, flavour);
  if (!target) return null;
  let blockId: string | null = null;
  store.captureSync();
  store.transact(() => {
    if (end > start) model.text!.delete(start, end - start);
    blockId = store.addBlock(flavour, { url }, target.parent, target.index + 1);
    if (
      target.anchor === model &&
      model.text?.yText.length === 0 &&
      model.children.length === 0
    ) {
      store.deleteBlock(model);
    }
  });
  store.captureSync();
  return blockId;
}

/**
 * Convert an external embed/bookmark card block back to an inline link paragraph.
 */
export function convertCardBlockToInlineLink(
  model: BlockModel,
  rawUrl: string,
  title?: string | null,
): string | null {
  const store = model.store;
  if (store.readonly || store.getModelById(model.id) !== model) return null;
  const parent = store.getParent(model);
  if (!parent) return null;
  const index = parent.children.indexOf(model);
  if (index < 0) return null;
  const url = normalizeUrl(rawUrl.trim());
  const label = title?.trim() || url;
  let paragraphId: string | null = null;
  store.captureSync();
  store.transact(() => {
    paragraphId = store.addBlock(
      "myoxus:paragraph",
      { text: new Text([{ insert: label, attributes: { link: url } }]) },
      parent,
      index,
    );
    store.deleteBlock(model);
  });
  store.captureSync();
  return paragraphId;
}

export function notifyCopied(message: string) {
  notify.success({ title: message });
}
