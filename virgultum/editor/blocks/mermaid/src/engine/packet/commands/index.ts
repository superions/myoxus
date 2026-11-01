// SPDX-License-Identifier: AGPL-3.0-or-later

import { mermaidMessages as messages } from "../../../i18n.js";
export * from "./field-commands.js";
export * from "./boundary-commands.js";
export * from "./metadata-commands.js";
import {
  applyPacketMetadataCommand,
  type PacketMetadataCommand,
  applyPacketCommentCommand,
  type PacketCommentCommand,
} from "./metadata-commands.js";

import type { MermaidPacketModel } from "../model.js";
import { packetNoChange, type PacketWriteOptions } from "../writer.js";
import {
  deletePacketField,
  splitPacketField,
  mergePacketFields,
  addPacketField,
  type PacketFieldAdd,
  reorderField,
  renamePacketField,
  editPacketField,
  type PacketFieldEdit,
} from "./field-commands.js";
import { moveBoundary, resizePacketEnd } from "./boundary-commands.js";
export type PacketCommand =
  | PacketCommentCommand
  | PacketMetadataCommand
  | { type: "delete-field"; fieldKey: string }
  | { type: "rename-field"; fieldKey: string; label: string }
  | { type: "edit-field"; fieldKey: string; edit: PacketFieldEdit }
  | {
      type: "move-boundary";
      leftKey: string;
      rightKey: string;
      nextBoundary: number;
    }
  | { type: "resize-end"; fieldKey: string; nextEnd: number }
  | { type: "reorder-field"; fieldKey: string; targetIndex: number }
  | { type: "add-field"; draft: PacketFieldAdd }
  | {
      type: "split-field";
      fieldKey: string;
      boundary: number;
      label: string;
      sourceForm: "range" | "count";
      secondKey?: string;
    }
  | {
      type: "merge-fields";
      fieldKey: string;
      neighborKey: string;
      label: string;
      sourceForm: "range" | "count";
    };
export function applyPacketCommand(
  model: MermaidPacketModel,
  command: PacketCommand,
  options: PacketWriteOptions = {},
) {
  if (options.intent === "cancel") return packetNoChange(model, "cancelled");
  if (options.readonly) return packetNoChange(model, "readonly");
  if (
    options.baseSource !== undefined &&
    options.baseSource !== model.sourceDocument.source
  )
    return packetNoChange(model, "conflict", messages.packetSourceConflict());
  switch (command.type) {
    case "accessibility":
    case "appearance":
      return applyPacketMetadataCommand(model, command, options);
    case "comment-add":
    case "comment-edit":
    case "comment-delete":
    case "comment-reorder":
      return applyPacketCommentCommand(model, command, options);
    case "delete-field":
      return deletePacketField(model, command.fieldKey, options);
    case "split-field":
      return splitPacketField(
        model,
        command.fieldKey,
        command.boundary,
        command.label,
        command.sourceForm,
        options,
        command.secondKey,
      );
    case "merge-fields":
      return mergePacketFields(
        model,
        command.fieldKey,
        command.neighborKey,
        command.label,
        command.sourceForm,
        options,
      );
    case "add-field":
      return addPacketField(model, command.draft, options);
    case "reorder-field":
      return reorderField(
        model,
        command.fieldKey,
        command.targetIndex,
        options,
      );
    case "rename-field":
      return renamePacketField(model, command.fieldKey, command.label, options);
    case "edit-field":
      return editPacketField(model, command.fieldKey, command.edit, options);
    case "move-boundary":
      return moveBoundary(
        model,
        command.leftKey,
        command.rightKey,
        command.nextBoundary,
        options,
      );
    case "resize-end":
      return resizePacketEnd(model, command.fieldKey, command.nextEnd, options);
  }
}
