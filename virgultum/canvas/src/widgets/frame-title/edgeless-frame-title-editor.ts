import { cssVar } from "@myoxus/theme";
import { Bound } from "@virgultum/core/primitives/gfx";
import { FrameBlockModel } from "@virgultum/core/models";
import type { BlockStdScope } from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";

import { frameTitleStyleVars } from "./styles";

export const frameTitleEditorCSS = `
  .frame-title-editor {
    display: flex;
    align-items: center;
    transform-origin: top left;
    border-radius: 4px;
    width: fit-content;
    padding: 0 4px;
    outline: none;
    z-index: 1;
    border: 1px solid var(--myoxus-primary-color);
    box-shadow: 0px 0px 0px 2px rgba(30, 150, 235, 0.3);
    overflow: hidden;
    font-family: var(--myoxus-font-family);
  }
`;

export function positionFrameTitleEditor(
  editor: HTMLElement,
  frame: FrameBlockModel,
  std: BlockStdScope,
) {
  const { grid, viewport } = std.get(GfxControllerIdentifier);
  const bound = Bound.deserialize(frame.xywh);
  const [x, y] = viewport.toViewCoord(bound.x, bound.y);
  const isInner = grid.has(
    frame.elementBound,
    true,
    true,
    (model) => model !== frame && model instanceof FrameBlockModel,
  );
  Object.assign(editor.style, {
    fontSize: `${frameTitleStyleVars.fontSize}px`,
    position: "absolute",
    left: `${isInner ? x + 4 : x}px`,
    top: `${isInner ? y + 4 : y - (frameTitleStyleVars.height + 4)}px`,
    minWidth: "8px",
    height: `${frameTitleStyleVars.height}px`,
    background: cssVar("noteBackgroundWhite"),
    color: "var(--myoxus-text-primary-color)",
  });
}
