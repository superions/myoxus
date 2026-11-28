// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { track, tracker } from "@myoxus/track";
import type { EditorHost } from "@virgultum/editor/std";
import type { GfxPrimitiveElementModel } from "@virgultum/editor/std/gfx";
import type { BlockModel } from "@virgultum/editor/store";

import {
  type ActionEventType,
  type AIActionEvent,
  AIProvider,
} from "./ai-provider";

type AIActionEventName =
  | "AI action invoked"
  | "AI action aborted"
  | "AI result discarded"
  | "AI result accepted";

type AIActionEventProperties = {
  page: "doc" | "edgeless" | "unknown";
  segment:
    | "AI action panel"
    | "right side bar"
    | "inline chat panel"
    | "AI result panel"
    | "AI chat block";
  module:
    | "exit confirmation"
    | "AI action panel"
    | "AI chat panel"
    | "inline chat panel"
    | "AI result panel"
    | "AI chat block";
  control:
    | "stop button"
    | "format toolbar"
    | "AI chat send button"
    | "Block action bar"
    | "policy wall"
    | "server error"
    | "login required"
    | "request timeout"
    | "insert"
    | "replace"
    | "use as caption"
    | "discard"
    | "retry"
    | "add note"
    | "add page"
    | "continue in chat";
  type:
    | "doc"
    | "note"
    | "text"
    | "image"
    | "draw object"
    | "chatbox text"
    | "other";
  category: string;
  other: Record<string, unknown>;
  docId?: string;
  workspaceId: string;
};

const OMITTED_OPTION_KEYS = new Set([
  "stream",
  "input",
  "content",
  "attachments",
  "signal",
  "docId",
  "workspaceId",
  "host",
  "models",
  "control",
  "where",
  "seed",
]);

const TEXT_BLOCK_FLAVOURS = new Set([
  "myoxus:paragraph",
  "myoxus:list",
  "myoxus:code",
]);

const EVENT_CONTROL_MAP: Partial<
  Record<ActionEventType, AIActionEventProperties["control"]>
> = {
  "aborted:stop": "stop button",
  "aborted:server-error": "server error",
  "aborted:login-required": "login required",
  "aborted:timeout": "request timeout",
  "result:add-note": "add note",
  "result:add-page": "add page",
  "result:continue-in-chat": "continue in chat",
  "result:insert": "insert",
  "result:replace": "replace",
  "result:use-as-caption": "use as caption",
  "result:discard": "discard",
  "result:retry": "retry",
};

function isBlockModel(
  model: BlockModel | GfxPrimitiveElementModel,
): model is BlockModel {
  return "flavour" in model;
}

function detectPageMode(host?: EditorHost): AIActionEventProperties["page"] {
  if (!host) return "unknown";
  return host.querySelector("myoxus-page-root") ? "doc" : "edgeless";
}

function detectObjectType(
  event: AIActionEvent,
): AIActionEventProperties["type"] {
  const models = event.options.models;
  if (!models) {
    if (event.action === "chat") return "chatbox text";
    return event.options.attachments?.length ? "image" : "text";
  }
  if (models.every((m) => !isBlockModel(m))) {
    return "draw object";
  }
  if (models.every(isBlockModel) && models.length > 0) {
    const flavour = models[0].flavour;
    if (flavour === "myoxus:note") return "note";
    if (TEXT_BLOCK_FLAVOURS.has(flavour)) return "text";
    if (flavour === "myoxus:image") return "image";
  }
  return "other";
}

function detectSegment(
  event: AIActionEvent,
): AIActionEventProperties["segment"] {
  if (event.options.where === "inline-chat-panel") return "inline chat panel";
  if (event.event.startsWith("result:")) return "AI result panel";
  if (event.options.where === "chat-panel") return "right side bar";
  if (event.options.where === "ai-chat-block") return "AI chat block";
  return "AI action panel";
}

function detectModule(event: AIActionEvent): AIActionEventProperties["module"] {
  if (event.options.where === "chat-panel") return "AI chat panel";
  if (event.event === "result:discard") return "exit confirmation";
  if (event.event.startsWith("result:")) return "AI result panel";
  if (event.options.where === "inline-chat-panel") return "inline chat panel";
  if (event.options.where === "ai-chat-block") return "AI chat block";
  return "AI action panel";
}

function detectEventName(event: AIActionEvent): AIActionEventName | null {
  if (event.event === "result:discard" || event.event === "result:retry") {
    return "AI result discarded";
  }
  if (event.event.startsWith("result:")) return "AI result accepted";
  if (event.event.startsWith("aborted:")) return "AI action aborted";
  if (event.event === "started") return "AI action invoked";
  return null;
}

function detectControl(
  event: AIActionEvent,
): AIActionEventProperties["control"] {
  const mapped = EVENT_CONTROL_MAP[event.event];
  if (mapped) return mapped;
  if (event.options.control === "chat-send") return "AI chat send button";
  if (event.options.control === "block-action-bar") return "Block action bar";
  return "format toolbar";
}

function formatCategoryName(action: string): string {
  return action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function extractExtraOptions(
  options: VirgultumPresets.AITextActionOptions,
): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!OMITTED_OPTION_KEYS.has(key)) {
      extra[key] = value;
    }
  }
  return extra;
}

export function setupTracker() {
  AIProvider.slots.requestLogin.subscribe(() => {
    track.doc.editor.aiActions.requestSignIn();
  });

  AIProvider.slots.actions.subscribe((event) => {
    const eventName = detectEventName(event);
    if (!eventName) return;

    tracker.track(eventName, {
      page: detectPageMode(event.options.host),
      segment: detectSegment(event),
      category: formatCategoryName(event.action),
      module: detectModule(event),
      control: detectControl(event),
      type: detectObjectType(event),
      other: extractExtraOptions(event.options),
      docId: event.options.docId,
      workspaceId: event.options.workspaceId,
    });
  });
}
