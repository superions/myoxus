// SPDX-License-Identifier: AGPL-3.0-or-later
import { MindmapLayoutType as LayoutType } from "../projection/types.js";

import type { MermaidVisualModel } from "../../runtime/gfx-model.js";
import type { MermaidGfxObjectEditIntent } from "../../runtime/editor-capabilities.js";
import { mermaidVisualFamilyPayload } from "../../runtime/gfx-family-data.js";
import { readMindmapProjectionOptions } from "../gfx-data.js";
import type { MindmapEditIntent } from "../react-host-contract.js";

export function mindmapIntentFromObjectEdit(
  intent: MermaidGfxObjectEditIntent,
): MindmapEditIntent | null {
  if (intent.kind !== "node" || intent.action === "select") return null;
  if (intent.action === "duplicate")
    return { type: "duplicate", keys: [intent.id] };
  if (intent.action === "delete") return { type: "delete", keys: [intent.id] };
  return {
    type:
      intent.action === "toggle-collapse"
        ? "toggle-collapse"
        : intent.action === "create-child"
          ? "add-child"
          : intent.action === "create-sibling"
            ? "add-sibling"
            : "rename",
    key: intent.id,
  };
}

/** Parent/order come from the Source projection, never spatial containment.
 * Scope, IME and input guards belong to the existing consuming key dispatcher;
 * Escape keeps that dispatcher's draft/selection/outer-Note exit sequence. */
export function mindmapNodeKeyboardIntent(
  visual: MermaidVisualModel,
  key: string,
  pressed: string,
): MermaidGfxObjectEditIntent | null {
  const options = readMindmapProjectionOptions(visual);
  const nodes = visual.nodes.map((node) => ({
    key: node.id,
    data: mermaidVisualFamilyPayload(node.familyData, "mindmap"),
  }));
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const rootKey = nodes.find((node) => node.data?.parentKey === null)?.key;
  const current = byKey.get(key);
  if (!current?.data) return null;
  const visible = (node: (typeof nodes)[number]) => {
    let parent = node.data?.parentKey;
    while (typeof parent === "string") {
      if (options.collapsed?.has(parent)) return false;
      parent = byKey.get(parent)?.data?.parentKey;
    }
    return true;
  };
  if (!visible(current)) return null;
  const intent = (
    action: MermaidGfxObjectEditIntent["action"],
    id = key,
  ): MermaidGfxObjectEditIntent => ({ kind: "node", id, action });
  if (pressed === "Duplicate") return intent("duplicate");
  if (pressed === "Delete" || pressed === "Backspace") return intent("delete");
  if (pressed === "Enter")
    return intent(
      current.data.parentKey === null ? "create-child" : "create-sibling",
    );
  if (pressed === "Tab") return intent("create-child");
  if (
    pressed === "F9" &&
    (options.collapsed?.has(key) ||
      nodes.some((node) => node.data?.parentKey === key))
  )
    return intent("toggle-collapse");
  if (pressed === "F2") return intent("edit");
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(pressed))
    return null;
  let branch = current;
  while (typeof branch.data?.parentKey === "string") {
    const parent = byKey.get(branch.data.parentKey);
    if (!parent || parent.data?.parentKey === null) break;
    branch = parent;
  }
  const side = (node: (typeof nodes)[number]) =>
    options.layout === LayoutType.BALANCE
      ? (options.rootSides?.get(node.key) ?? LayoutType.RIGHT)
      : (options.layout ?? LayoutType.RIGHT);
  const ordered = nodes
    .filter(visible)
    .sort((a, b) => Number(a.data?.order ?? 0) - Number(b.data?.order ?? 0));
  if (pressed === "ArrowUp" || pressed === "ArrowDown") {
    const siblings = ordered.filter(
      (node) =>
        node.data?.parentKey === current.data!.parentKey &&
        (options.layout !== LayoutType.BALANCE ||
          current.data!.parentKey !== rootKey ||
          side(node) === side(branch)),
    );
    // BALANCE lays out the left root branches in reverse Source order.
    if (
      options.layout === LayoutType.BALANCE &&
      current.data.parentKey === rootKey &&
      side(branch) === LayoutType.LEFT
    )
      siblings.reverse();
    return intent(
      "select",
      siblings[siblings.indexOf(current) + (pressed === "ArrowDown" ? 1 : -1)]
        ?.key ?? key,
    );
  }
  const direction =
    current.data.parentKey === null && options.layout === LayoutType.BALANCE
      ? LayoutType.BALANCE
      : side(branch);
  const towardChild =
    pressed === "ArrowLeft"
      ? direction !== LayoutType.RIGHT
      : direction !== LayoutType.LEFT;
  const children = ordered.filter(
    (node) =>
      node.data?.parentKey === key &&
      (options.layout !== LayoutType.BALANCE ||
        current.data!.parentKey !== null ||
        side(node) ===
          (pressed === "ArrowLeft" ? LayoutType.LEFT : LayoutType.RIGHT)),
  );
  if (
    options.layout === LayoutType.BALANCE &&
    key === rootKey &&
    pressed === "ArrowLeft"
  )
    children.reverse();
  const destination = towardChild ? children[0]?.key : current.data.parentKey;
  return intent("select", typeof destination === "string" ? destination : key);
}
