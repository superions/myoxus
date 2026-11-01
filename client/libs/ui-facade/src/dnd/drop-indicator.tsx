// SPDX-License-Identifier: MIT

import "./drop-indicator.css";

import type { Edge } from "@atlaskit/pragmatic-drag-and-drop-hitbox/closest-edge";
import type { Instruction } from "@atlaskit/pragmatic-drag-and-drop-hitbox/tree-item";
import { cssVar } from "@myoxus/theme";
import { type CSSProperties, type ReactElement } from "react";

import { joinClassName } from "../css-utils";

export type DropIndicatorProps = {
  instruction?: Instruction | null;
  edge?: Edge | null;
  noTerminal?: boolean;
};

function getTreeElement({
  instruction,
  isBlocked,
  noTerminal,
}: {
  instruction: Exclude<Instruction, { type: "instruction-blocked" }>;
  isBlocked: boolean;
  noTerminal?: boolean;
}): ReactElement | null {
  const style: CSSProperties & Record<string, string> = {
    ["--myoxus-dnd-horizontal-indent"]: `${instruction.currentLevel * instruction.indentPerLevel}px`,
    ["--myoxus-dnd-indicator-color"]: !isBlocked
      ? cssVar("--myoxus-primary-color")
      : cssVar("--myoxus-warning-color"),
  };

  if (instruction.type === "reorder-above") {
    return (
      <div
        className={joinClassName(
          "myoxus-dnd-tree-line",
          "myoxus-dnd-line-above",
        )}
        style={style}
        data-no-terminal={noTerminal}
      />
    );
  }
  if (instruction.type === "reorder-below") {
    return (
      <div
        className={joinClassName(
          "myoxus-dnd-tree-line",
          "myoxus-dnd-line-below",
        )}
        style={style}
        data-no-terminal={noTerminal}
      />
    );
  }

  if (instruction.type === "make-child") {
    return (
      <div
        className={joinClassName("myoxus-dnd-outline")}
        style={style}
        data-no-terminal={noTerminal}
      />
    );
  }

  if (instruction.type === "reparent") {
    style["--myoxus-dnd-horizontal-indent"] = `${
      instruction.desiredLevel * instruction.indentPerLevel
    }px`;

    return (
      <div
        className={joinClassName(
          "myoxus-dnd-tree-line",
          "myoxus-dnd-line-below",
        )}
        style={style}
        data-no-terminal={noTerminal}
      />
    );
  }
  return null;
}

type Orientation = "horizontal" | "vertical";

const edgeToOrientationMap: Record<Edge, Orientation> = {
  top: "horizontal",
  bottom: "horizontal",
  left: "vertical",
  right: "vertical",
};

const orientationStyles: Record<Orientation, string> = {
  horizontal: "myoxus-dnd-horizontal",
  vertical: "myoxus-dnd-vertical",
};

const edgeStyles: Record<Edge, string> = {
  top: "myoxus-dnd-top",
  bottom: "myoxus-dnd-bottom",
  left: "myoxus-dnd-left",
  right: "myoxus-dnd-right",
};

function getEdgeElement(edge: Edge, gap: number = 0, noTerminal?: boolean) {
  const lineOffset = `calc(-0.5 * (${gap}px + 2px))`;

  const orientation = edgeToOrientationMap[edge];

  return (
    <div
      data-no-terminal={noTerminal}
      className={joinClassName(
        "myoxus-dnd-edge-line",
        orientationStyles[orientation],
        edgeStyles[edge],
      )}
      style={{ ["--myoxus-dnd-line-offset"]: lineOffset } as CSSProperties}
    />
  );
}

export function DropIndicator({
  instruction,
  edge,
  noTerminal,
}: DropIndicatorProps) {
  if (edge) {
    return getEdgeElement(edge, 0, noTerminal);
  }
  if (instruction) {
    if (instruction.type === "instruction-blocked") {
      return getTreeElement({
        instruction: instruction.desired,
        isBlocked: true,
      });
    }
    return getTreeElement({ instruction, isBlocked: false });
  }
  return;
}
