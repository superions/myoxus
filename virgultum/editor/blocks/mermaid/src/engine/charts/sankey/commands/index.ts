// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SankeyModel } from "../model.js";
import { parseSankeySource } from "../parser.js";
import { sankeyNoChange } from "../writer.js";
import {
  applySankeyCommentCommand,
  type SankeyCommentCommand,
} from "./comment.js";
import {
  applySankeyConfigCommand,
  type SankeyConfigCommand,
} from "./config.js";
import { applySankeyLinkCommand, type SankeyLinkCommand } from "./link.js";
import {
  applySankeyMetadataCommand,
  type SankeyMetadataCommand,
} from "./metadata.js";
import { applySankeyNodeCommand, type SankeyNodeCommand } from "./node.js";

export type SankeyCommand =
  | SankeyLinkCommand
  | SankeyNodeCommand
  | SankeyConfigCommand
  | SankeyCommentCommand
  | SankeyMetadataCommand;

/** Resolve current source before locating a target; never overwrite a stale draft. */
export function applySankeyCommand(input: {
  readonly model: SankeyModel;
  readonly source: string;
  readonly command: SankeyCommand;
  readonly readonly: boolean;
}) {
  if (input.readonly)
    return { ...sankeyNoChange(input.model, "readonly"), source: input.source };
  const model =
    input.source === input.model.sourceDocument.source
      ? input.model
      : parseSankeySource(input.source, input.model);
  if (!model)
    return { ...sankeyNoChange(input.model, "conflict"), source: input.source };
  const command = input.command;
  if (
    "id" in command &&
    model.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "conflict" && diagnostic.recordId === command.id,
    )
  )
    return sankeyNoChange(model, "conflict");
  switch (command.type) {
    case "link.add":
    case "link.endpoint":
    case "link.value":
    case "link.delete":
    case "link.reorder":
      return applySankeyLinkCommand(model, command);
    case "node.rename":
    case "node.delete":
      return applySankeyNodeCommand(model, command);
    case "config.set":
      return applySankeyConfigCommand(model, command);
    case "diagram.title":
      return applySankeyMetadataCommand(model, command);
    case "comment.add":
    case "comment.edit":
    case "comment.delete":
      return applySankeyCommentCommand(model, command);
  }
}
