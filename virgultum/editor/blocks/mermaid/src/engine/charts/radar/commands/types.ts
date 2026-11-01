// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidRadarConfig, MermaidRadarModel } from "../model.js";
import type { MermaidRadarQuoteForm } from "../source-document.js";

export type MermaidRadarCommandSelection =
  | {
      readonly id: string;
      readonly kind: "axis" | "comment" | "curve" | "vertex";
    }
  | { readonly kind: "diagram" | "options" };

export type MermaidRadarAxisCommand =
  | {
      readonly label: string;
      readonly name: string;
      readonly type: "axis.add";
      readonly values: Readonly<Record<string, number>>;
    }
  | {
      readonly axisId: string;
      readonly label: string;
      readonly type: "axis.label";
    }
  | {
      readonly axisId: string;
      readonly name: string;
      readonly type: "axis.name";
    }
  | {
      readonly axisId: string;
      readonly beforeAxisId?: string;
      readonly type: "axis.reorder";
    }
  | { readonly axisId: string; readonly type: "axis.delete" };

export type MermaidRadarCurveCommand =
  | {
      readonly form: "detailed" | "positional";
      readonly label: string;
      readonly name: string;
      readonly type: "curve.add";
      readonly values: Readonly<Record<string, number>>;
    }
  | {
      readonly curveId: string;
      readonly label: string;
      readonly type: "curve.label";
    }
  | {
      readonly curveId: string;
      readonly name: string;
      readonly type: "curve.name";
    }
  | {
      readonly beforeCurveId?: string;
      readonly curveId: string;
      readonly type: "curve.reorder";
    }
  | { readonly curveId: string; readonly type: "curve.delete" }
  | {
      readonly curveId: string;
      readonly form: "detailed" | "positional";
      readonly type: "curve.form";
    };

export type MermaidRadarVertexCommand =
  | {
      readonly axisId: string;
      readonly curveId: string;
      readonly type: "vertex.add" | "vertex.repair";
      readonly value: number;
    }
  | { readonly entryId: string; readonly type: "vertex.delete" }
  | {
      readonly entryId: string;
      readonly axisId: string;
      readonly type: "vertex.reference";
    }
  | {
      readonly entryId: string;
      readonly type: "vertex.value";
      readonly value: number;
    };

export type MermaidRadarOptionsCommand = {
  readonly graticule: "circle" | "polygon";
  readonly max: number | null;
  readonly min: number;
  readonly showLegend: boolean;
  readonly ticks: number;
  readonly type: "options.apply";
};

export type MermaidRadarConfigCommand = {
  readonly config: Required<MermaidRadarConfig>;
  readonly type: "config.apply";
};

export type MermaidRadarMetadataCommand =
  | {
      readonly description: string;
      readonly title: string;
      readonly type: "diagram.accessibility";
    }
  | { readonly title: string; readonly type: "diagram.title" };

export type MermaidRadarCommentCommand =
  | {
      readonly anchor:
        | { readonly kind: "diagram" }
        | {
            readonly id: string;
            readonly kind: "axis" | "curve" | "metadata" | "options";
          };
      readonly position: "after" | "before";
      readonly text: string;
      readonly type: "comment.add";
    }
  | {
      readonly commentId: string;
      readonly text: string;
      readonly type: "comment.edit";
    }
  | { readonly commentId: string; readonly type: "comment.delete" };

export type MermaidRadarCommand =
  | MermaidRadarAxisCommand
  | MermaidRadarCommentCommand
  | MermaidRadarConfigCommand
  | MermaidRadarCurveCommand
  | MermaidRadarMetadataCommand
  | MermaidRadarOptionsCommand
  | MermaidRadarVertexCommand;

export type MermaidRadarCommandResult = {
  readonly changed: boolean;
  readonly diagnosis: string;
  readonly model: MermaidRadarModel;
  readonly selectionAfter: MermaidRadarCommandSelection | null;
  readonly source: string;
};

export type MermaidRadarCommandContext = {
  readonly command: MermaidRadarCommand;
  readonly model: MermaidRadarModel;
  readonly source: string;
};

export const RADAR_ID_PATTERN = /^[\w](?:[-\w]*\w)?$/;

export function validRadarValue(value: number) {
  return Number.isFinite(value) && value >= 0;
}

export function encodeRadarLabel(
  value: string,
  quote: MermaidRadarQuoteForm = "double",
) {
  if (quote === "double") return JSON.stringify(value);
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}
