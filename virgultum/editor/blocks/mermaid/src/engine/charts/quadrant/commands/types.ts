// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  MermaidQuadrantComment,
  MermaidQuadrantCommentAnchor,
  MermaidQuadrantConfig,
  MermaidQuadrantInlineStyle,
  MermaidQuadrantModel,
} from "../model.js";
import type {
  MermaidQuadrantAxisForm,
  MermaidQuadrantTextForm,
} from "../source-document.js";

export type MermaidQuadrantCommandSelection =
  | { kind: "diagram" }
  | {
      id: string;
      kind: "axis" | "classDef" | "comment" | "point" | "quadrantText";
    };

export type MermaidQuadrantPointCommand =
  | {
      afterPointId?: string;
      className?: string;
      inlineStyle?: MermaidQuadrantInlineStyle;
      label: string;
      labelForm: MermaidQuadrantTextForm;
      type: "point.add";
      x: number;
      y: number;
    }
  | { label: string; pointId: string; type: "point.rename" }
  | {
      form: MermaidQuadrantTextForm;
      pointId: string;
      type: "point.label-form";
    }
  | { pointId: string; type: "point.move"; x: number; y: number }
  | { beforePointId?: string; pointId: string; type: "point.reorder" }
  | { pointId: string; type: "point.delete" }
  | { className?: string; pointId: string; type: "point.class" };

export type MermaidQuadrantTextCommand =
  | {
      axis: "x" | "y";
      end: string;
      endForm?: MermaidQuadrantTextForm;
      form?: MermaidQuadrantAxisForm;
      start: string;
      startForm?: MermaidQuadrantTextForm;
      type: "text.axis";
    }
  | {
      form?: MermaidQuadrantTextForm;
      quadrant: 1 | 2 | 3 | 4;
      text: string;
      type: "text.quadrant";
    };

export type MermaidQuadrantAppearanceCommand =
  | {
      pointId: string;
      style: MermaidQuadrantInlineStyle;
      type: "appearance.point-style";
    }
  | {
      classDefId?: string;
      name: string;
      style: MermaidQuadrantInlineStyle;
      type: "appearance.class-add";
    }
  | {
      classDefId: string;
      name: string;
      style: MermaidQuadrantInlineStyle;
      type: "appearance.class-update";
    }
  | {
      classDefId: string;
      confirmAffectedPointIds?: readonly string[];
      replacementClassId?: string;
      type: "appearance.class-delete";
    }
  | { config: MermaidQuadrantConfig; type: "appearance.config" }
  | { title: string; type: "diagram.title" }
  | {
      description: string;
      title: string;
      type: "diagram.accessibility";
    };

export type MermaidQuadrantCommentCommand =
  | {
      anchor: MermaidQuadrantCommentAnchor;
      position: MermaidQuadrantComment["position"];
      text: string;
      type: "comment.add";
    }
  | { commentId: string; text: string; type: "comment.update" }
  | { commentId: string; type: "comment.delete" };

export type MermaidQuadrantCommand =
  | MermaidQuadrantAppearanceCommand
  | MermaidQuadrantCommentCommand
  | MermaidQuadrantPointCommand
  | MermaidQuadrantTextCommand;

export type MermaidQuadrantCommandResult = {
  changed: boolean;
  command: MermaidQuadrantCommand;
  diagnosis: { code: string; recordId?: string };
  model: MermaidQuadrantModel;
  selectionAfter: MermaidQuadrantCommandSelection;
};
