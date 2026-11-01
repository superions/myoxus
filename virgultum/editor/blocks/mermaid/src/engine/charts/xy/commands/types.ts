// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidXyModel } from "../model.js";
import type { MermaidXyAxisCommand, MermaidXyCategoryCommand } from "./axis.js";
import type { MermaidXyAppearanceCommand } from "./appearance.js";
import type { MermaidXyCommentCommand } from "./comment.js";
import type { MermaidXyPlotCommand } from "./plot.js";
import type { MermaidXyPointCommand } from "./point.js";

export type MermaidXyCommand =
  | MermaidXyAppearanceCommand
  | MermaidXyAxisCommand
  | MermaidXyCategoryCommand
  | MermaidXyCommentCommand
  | MermaidXyPlotCommand
  | MermaidXyPointCommand;

export type MermaidXyCommandSelection =
  | { kind: "diagram" }
  | {
      id: string;
      kind: "category" | "comment" | "plot" | "point" | "x-axis" | "y-axis";
    };

export type MermaidXyCommandValidation = {
  code: string;
  selectionAfter: MermaidXyCommandSelection;
  valid: boolean;
};

export type MermaidXyCommandResult = MermaidXyCommandValidation & {
  changed: boolean;
  command: MermaidXyCommand;
  model: MermaidXyModel;
};
