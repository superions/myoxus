// SPDX-License-Identifier: AGPL-3.0-or-later

import type { TreemapModel } from "../model.js";
import { treemapNoChange } from "../writer.js";
import {
  applyTreemapAppearanceCommand,
  type TreemapAppearanceCommand,
} from "./appearance.js";
import { applyTreemapClassCommand, type TreemapClassCommand } from "./class.js";
import {
  applyTreemapCommentCommand,
  type TreemapCommentCommand,
} from "./comment.js";
import {
  applyTreemapHierarchyCommand,
  type TreemapHierarchyCommand,
} from "./hierarchy.js";
import {
  applyTreemapMetadataCommand,
  type TreemapMetadataCommand,
} from "./metadata.js";
import { applyTreemapNodeCommand, type TreemapNodeCommand } from "./node.js";
import { applyTreemapValueCommand, type TreemapValueCommand } from "./value.js";

export type TreemapCommand =
  | TreemapAppearanceCommand
  | TreemapClassCommand
  | TreemapCommentCommand
  | TreemapHierarchyCommand
  | TreemapMetadataCommand
  | TreemapNodeCommand
  | TreemapValueCommand;

export function applyTreemapCommand(input: {
  readonly model: TreemapModel;
  readonly source: string;
  readonly readonly: boolean;
  readonly command: TreemapCommand;
}) {
  if (input.readonly) return treemapNoChange(input.model, "readonly");
  if (input.source !== input.model.sourceDocument.source)
    return treemapNoChange(input.model, "conflict");
  const { command, model } = input;
  if (command.type.startsWith("appearance."))
    return applyTreemapAppearanceCommand(
      model,
      command as TreemapAppearanceCommand,
    );
  if (command.type.startsWith("class."))
    return applyTreemapClassCommand(model, command as TreemapClassCommand);
  if (command.type.startsWith("comment."))
    return applyTreemapCommentCommand(model, command as TreemapCommentCommand);
  if (command.type.startsWith("hierarchy."))
    return applyTreemapHierarchyCommand(
      model,
      command as TreemapHierarchyCommand,
    );
  if (command.type.startsWith("metadata."))
    return applyTreemapMetadataCommand(
      model,
      command as TreemapMetadataCommand,
    );
  if (command.type.startsWith("node."))
    return applyTreemapNodeCommand(model, command as TreemapNodeCommand);
  return applyTreemapValueCommand(model, command as TreemapValueCommand);
}

export * from "./appearance.js";
export * from "./class.js";
export * from "./comment.js";
export * from "./hierarchy.js";
export * from "./metadata.js";
export * from "./node.js";
export * from "./value.js";
