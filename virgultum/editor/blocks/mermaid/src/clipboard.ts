// SPDX-License-Identifier: AGPL-3.0-or-later

import { prepareMermaidOwnerCopy } from "./commands/copy-identities.js";
import { DisposableGroup } from "@virgultum/global/disposable";
import type { MermaidBlockModel } from "@virgultum/model";
import { getSelectedModelsCommand } from "@virgultum/shared/commands";
import {
  BlockSelection,
  type BlockStdScope,
  LifeCycleWatcher,
  type UIEventHandler,
} from "@virgultum/std";
import type { SerializedElement } from "@virgultum/std/gfx";
import type { BlockModel } from "@virgultum/store";

import {
  cleanupPartialMermaidOwner,
  createMermaidOwnerDuplicatePlan,
  duplicateMermaidOwnerChildren,
  type MermaidOwnerDuplicatePlan,
} from "./commands/materialization.js";
import { createMermaidBlockInsertProps } from "./commands.js";
import { resolveMermaidFamilyRuntime } from "./families/runtime/registry.js";
import { isMermaidBlockModel } from "./presentation/owner.js";
import { resolveMermaidGfxProjection } from "./presentation/gfx-projection-owner.js";
import { canProjectMermaidNatively } from "./presentation/owner.js";
import { getMermaidBlockSource, getMermaidBlockTitle } from "./utils.js";

export const MERMAID_CLIPBOARD_MIME = "myoxus/mermaid-block";

export type MermaidClipboardPort = {
  subscribe: (
    handlers: Partial<
      Record<"copy" | "paste" | "cut", (event: ClipboardEvent) => boolean>
    >,
  ) => () => void;
  read: (event: ClipboardEvent) => Record<string, unknown>;
  /** Explicit pointer actions use the same snapshot decoder as native paste. */
  readCurrent?: () => Promise<Record<string, unknown>>;
  write: (items: Record<string, string>) => Promise<void>;
};

/** The existing Std dispatcher retains clipboard ownership and event priority.
 * Family consumers register only while mounted, within their actual scope. */
export function createMermaidClipboardPort(
  std: BlockStdScope,
  owns: (event: ClipboardEvent) => boolean,
  blockId?: string,
): MermaidClipboardPort {
  return {
    subscribe: (handlers) => {
      const disposables = new DisposableGroup();
      for (const name of ["copy", "paste", "cut"] as const) {
        const handler = handlers[name];
        if (handler)
          disposables.add(
            std.event.add(
              name,
              (ctx) => {
                const event = ctx.get("clipboardState").raw;
                const target = event.target;
                // Page canvas focus proxies inherit contenteditable from the
                // document root; they are still diagram controls, not text inputs.
                if (
                  target instanceof Element &&
                  (target.closest(
                    'input,textarea,[role="dialog"],[role="menu"]',
                  ) ||
                    (target instanceof HTMLElement &&
                      target.isContentEditable &&
                      !event
                        .composedPath()
                        .some(
                          (node) =>
                            node instanceof Element &&
                            node.matches(".myoxus-mermaid-gfx-viewport"),
                        )))
                )
                  return false;
                return owns(event) && handler(event);
              },
              blockId ? { blockId } : undefined,
            ),
          );
      }
      return () => disposables.dispose();
    },
    read: (event) => {
      if (!event.clipboardData) return {};
      try {
        return std.clipboard.readFromClipboard(event.clipboardData);
      } catch {
        return {};
      }
    },
    readCurrent: async () => {
      const items = await navigator.clipboard.read();
      const html = items.find((item) => item.types.includes("text/html"));
      if (!html) return {};
      const data = new DataTransfer();
      data.setData("text/html", await (await html.getType("text/html")).text());
      try {
        return std.clipboard.readFromClipboard(data);
      } catch {
        return {};
      }
    },
    write: async (items) => {
      // Std carries custom MIME entries in its HTML snapshot envelope. Supplying
      // only plain text omits that envelope and loses the typed Source bindings.
      const text = (items["text/plain"] ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;");
      await std.clipboard.writeToClipboard(async (current) => ({
        ...current,
        ...items,
        "text/html": `<pre>${text}</pre>`,
      }));
    },
  };
}

export type MermaidClipboardPayloadV2 = {
  readonly familyData?: string;
  readonly comments?: Record<string, boolean>;
  readonly diagramType: string;
  readonly elements: readonly SerializedElement[];
  readonly ownerId: string;
  readonly ownerXYWH: string | null;
  readonly source: string;
  readonly title: string;
  readonly version: 2;
};

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function cloneRecord<T>(record: T | undefined): T | undefined {
  return record ? ({ ...record } as T) : undefined;
}

function isBooleanRecord(value: unknown): value is Record<string, boolean> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "boolean")
  );
}

function decodeMermaidClipboardPayload(payload: MermaidClipboardPayloadV2) {
  if (
    payload?.version !== 2 ||
    (payload.familyData !== undefined &&
      typeof payload.familyData !== "string") ||
    typeof payload.ownerId !== "string" ||
    !payload.ownerId ||
    typeof payload.source !== "string" ||
    !payload.source.trim() ||
    typeof payload.title !== "string" ||
    typeof payload.diagramType !== "string" ||
    !Array.isArray(payload.elements) ||
    (payload.comments !== undefined && !isBooleanRecord(payload.comments))
  ) {
    return null;
  }

  const resolution = resolveMermaidFamilyRuntime(payload.source);
  if (
    resolution.kind !== "resolved" ||
    resolution.diagramType !== payload.diagramType
  ) {
    return null;
  }

  if (!canProjectMermaidNatively(resolution)) {
    return payload.ownerXYWH === null && payload.elements.length === 0
      ? { resolution }
      : null;
  }
  if (typeof payload.ownerXYWH !== "string") return null;

  const elementIds = new Set<string>();
  for (const element of payload.elements) {
    if (
      !element ||
      (element.type !== "shape" && element.type !== "connector") ||
      typeof element.id !== "string" ||
      !element.id ||
      elementIds.has(element.id) ||
      typeof element.mermaidRole !== "string" ||
      !element.mermaidRole
    ) {
      return null;
    }
    elementIds.add(element.id);
  }
  for (const element of payload.elements) {
    if (element.type !== "connector") continue;
    const sourceId = (element.source as { id?: unknown } | undefined)?.id;
    const targetId = (element.target as { id?: unknown } | undefined)?.id;
    if (
      typeof sourceId !== "string" ||
      typeof targetId !== "string" ||
      !elementIds.has(sourceId) ||
      !elementIds.has(targetId)
    ) {
      return null;
    }
  }
  return { resolution };
}

export function validateMermaidClipboardPayloadV2(
  payload: MermaidClipboardPayloadV2,
) {
  return Boolean(decodeMermaidClipboardPayload(payload));
}

export function createMermaidClipboardPayloadV2(
  block: MermaidBlockModel,
): MermaidClipboardPayloadV2 | null {
  const source = getMermaidBlockSource(block.props);
  const resolution = resolveMermaidFamilyRuntime(source);
  if (resolution.kind !== "resolved") return null;

  let elements: readonly SerializedElement[] = [];
  let ownerXYWH: string | null = null;
  if (canProjectMermaidNatively(resolution)) {
    const projection = resolveMermaidGfxProjection(block);
    if (!projection) return null;
    const plan = createMermaidOwnerDuplicatePlan(projection.owner);
    if (!plan) return null;
    elements = cloneJson(plan.snapshots) as SerializedElement[];
    ownerXYWH = projection.ownerXYWH;
  }

  const payload: MermaidClipboardPayloadV2 = {
    comments: cloneRecord(block.props.comments),
    familyData: block.props.familyData,
    diagramType: resolution.diagramType,
    elements,
    ownerId: block.id,
    ownerXYWH,
    source,
    title: getMermaidBlockTitle(block.props),
    version: 2,
  };
  return validateMermaidClipboardPayloadV2(payload) ? payload : null;
}

export function pasteMermaidClipboardPayloadV2({
  place = "after",
  payload,
  std,
  targetModel,
}: {
  place?: "after" | "before";
  payload: MermaidClipboardPayloadV2;
  std: BlockStdScope;
  targetModel: BlockModel;
}) {
  const decoded = decodeMermaidClipboardPayload(payload);
  if (std.store.readonly || !decoded || !std.store.getParent(targetModel))
    return null;
  const copy = prepareMermaidOwnerCopy(
    payload.source,
    payload.familyData ?? "",
    payload.comments,
  );
  if (!copy) return null;

  std.store.captureSync();
  let blockId: string | null = null;
  let elementIds: string[] = [];
  try {
    const [createdId] = std.store.addSiblingBlocks(
      targetModel,
      [
        {
          ...createMermaidBlockInsertProps({
            source: payload.source,
            title: payload.title,
            preserveSourceBytes: true,
          }),
          comments: copy.comments,
          familyData: copy.familyData,
          ...(payload.ownerXYWH ? { xywh: payload.ownerXYWH } : {}),
        },
      ],
      place,
    );
    blockId = createdId ?? null;
    const owner = blockId ? std.store.getBlock(blockId)?.model : null;
    if (!isMermaidBlockModel(owner)) {
      throw new Error("failed to create pasted Mermaid owner");
    }

    let duplicated = {
      connectorIds: [] as string[],
      elementIds: [] as string[],
      shapeIds: [] as string[],
    };
    if (canProjectMermaidNatively(decoded.resolution)) {
      duplicated = duplicateMermaidOwnerChildren({
        ctx: { std },
        dx: 0,
        dy: 0,
        plan: {
          snapshots: cloneJson(payload.elements).map((element) => ({
            ...element,
            ...copy.remapElement(element),
          })),
        } as MermaidOwnerDuplicatePlan,
        targetOwner: owner,
      });
      elementIds = duplicated.elementIds;
    }

    std.selection.setGroup("note", [
      std.selection.create(BlockSelection, { blockId }),
    ]);
    std.store.captureSync();
    return {
      blockId,
      connectorIds: duplicated.connectorIds,
      elementIds: duplicated.elementIds,
      ownerId: blockId,
      shapeIds: duplicated.shapeIds,
    };
  } catch (error) {
    cleanupPartialMermaidOwner({ std }, { elementIds, ownerId: blockId });
    std.store.captureSync();
    console.warn("[mermaid:block] clipboard paste rolled back", error);
    return null;
  }
}

function getSelectedMermaidBlock(std: BlockStdScope) {
  const [, ctx] = std.command.exec(getSelectedModelsCommand, {
    types: ["block"],
  });
  const selected = ctx.selectedModels?.filter(isMermaidBlockModel) ?? [];
  const block = selected.length === 1 ? selected[0] : null;
  return block?.store.getParent(block.id)?.flavour === "myoxus:surface"
    ? null
    : block;
}

function getPasteTargetModel(std: BlockStdScope) {
  const [, ctx] = std.command.exec(getSelectedModelsCommand, {
    types: ["block", "text", "image"],
  });
  const target = ctx.selectedModels?.at(-1) ?? null;
  return target?.store.getParent(target.id)?.flavour === "myoxus:surface"
    ? null
    : target;
}

export class MermaidClipboardController extends LifeCycleWatcher {
  static override key = "myoxus-mermaid-clipboard";

  private readonly _disposables = new DisposableGroup();

  private readonly _onCopy: UIEventHandler = (ctx) => {
    const event = ctx.get("clipboardState").raw;
    const block = getSelectedMermaidBlock(this.std);
    if (!block) return false;

    const payload = createMermaidClipboardPayloadV2(block);
    if (!payload) return false;

    event.preventDefault();
    createMermaidClipboardPort(this.std, () => true)
      .write({
        "text/plain": payload.source,
        [MERMAID_CLIPBOARD_MIME]: JSON.stringify(payload),
      })
      .catch(console.error);
    return true;
  };

  private readonly _onPaste: UIEventHandler = (ctx) => {
    const event = ctx.get("clipboardState").raw;
    const data = event.clipboardData;
    if (!data || this.std.store.readonly) return false;

    let encoded: string | undefined;
    try {
      encoded =
        this.std.clipboard.readFromClipboard(data)[MERMAID_CLIPBOARD_MIME];
    } catch {
      return false;
    }
    if (!encoded) return false;

    const targetModel = getPasteTargetModel(this.std);
    if (!targetModel) return false;

    let payload: MermaidClipboardPayloadV2;
    try {
      payload = JSON.parse(encoded) as MermaidClipboardPayloadV2;
    } catch {
      return false;
    }
    const pasted = pasteMermaidClipboardPayloadV2({
      payload,
      std: this.std,
      targetModel,
    });
    if (!pasted) return false;

    event.preventDefault();
    return true;
  };

  override mounted() {
    this._disposables.add(this.std.event.add("copy", this._onCopy));
    this._disposables.add(this.std.event.add("paste", this._onPaste));
  }

  override unmounted() {
    this._disposables.dispose();
  }
}
