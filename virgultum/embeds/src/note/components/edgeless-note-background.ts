import { clamp, Point } from "@virgultum/core/primitives/gfx";
import {
  DefaultTheme,
  ListBlockModel,
  type NoteBlockModel,
  ParagraphBlockModel,
  StrokeStyle,
} from "@virgultum/core/models";
import { ThemeProvider } from "@virgultum/core/services";
import {
  getClosestBlockComponentByPoint,
  handleNativeRangeAtPoint,
  matchModels,
} from "@virgultum/core/utils";
import {
  type BlockComponent,
  type BlockStdScope,
  TextSelection,
} from "@virgultum/core/runtime";
import { GfxControllerIdentifier } from "@virgultum/core/runtime/gfx";
import type { BlockModel } from "@virgultum/core/store";

export function readCanvasNoteBackground(
  std: BlockStdScope,
  note: NoteBlockModel,
) {
  const themeProvider = std.get(ThemeProvider);
  const theme = themeProvider.theme$.value;
  const backgroundColor = themeProvider.generateColorProperty(
    note.props.background$.value,
    DefaultTheme.noteBackgrounColor,
    theme,
  );

  const { borderRadius, borderSize, borderStyle, shadowType } =
    note.props.edgeless$.value.style;

  // When the note has no explicit border (default for page blocks in
  // edgeless view), fall back to a 1px hairline so the region is still
  // visually distinguishable from the canvas.
  const useHairlineFallback =
    borderStyle === StrokeStyle.None && note.isPageBlock();

  return {
    borderRadius: borderRadius + "px",
    backgroundColor: backgroundColor,
    borderWidth: useHairlineFallback ? "1px" : `${borderSize}px`,
    borderStyle: useHairlineFallback
      ? "solid"
      : borderStyle === StrokeStyle.Dash
        ? "dashed"
        : borderStyle,
    boxShadow: !shadowType ? "none" : `var(${shadowType})`,
  };
}

function tryAddCanvasNoteParagraph(
  anchor: HTMLElement,
  note: NoteBlockModel,
  std: BlockStdScope,
  x: number,
  y: number,
) {
  const nearest = getClosestBlockComponentByPoint(
    new Point(x, y),
  ) as BlockComponent | null;
  if (!nearest) return;

  const nearestBBox = nearest.getBoundingClientRect();
  const yRel = y - nearestBBox.top;

  const insertPos: "before" | "after" =
    yRel < nearestBBox.height / 2 ? "before" : "after";

  const nearestModel = nearest.model as BlockModel;
  const nearestModelIdx = note.children.indexOf(nearestModel);

  const children = note.children;
  const siblingModel =
    children[
      clamp(
        nearestModelIdx + (insertPos === "before" ? -1 : 1),
        0,
        children.length,
      )
    ];

  if (
    (!nearestModel.text ||
      !matchModels(nearestModel, [ParagraphBlockModel, ListBlockModel])) &&
    (!siblingModel ||
      !siblingModel.text ||
      !matchModels(siblingModel, [ParagraphBlockModel, ListBlockModel]))
  ) {
    const [pId] = note.store.addSiblingBlocks(
      nearestModel,
      [{ flavour: "myoxus:paragraph" }],
      insertPos,
    );

    std.view
      .getBlock(note.id)
      ?.updateComplete.then(() => {
        if (anchor.isConnected) {
          std.selection.setGroup("note", [
            std.selection.create(TextSelection, {
              from: { blockId: pId, index: 0, length: 0 },
              to: null,
            }),
          ]);
        }
      })
      .catch(console.error);
  }
}

export function focusCanvasNoteBackground(
  anchor: HTMLElement,
  note: NoteBlockModel,
  std: BlockStdScope,
  editing: boolean,
  e: MouseEvent,
) {
  e.stopPropagation();
  if (!editing) return;

  const { zoom } = std.get(GfxControllerIdentifier).viewport;

  const rect = anchor.getBoundingClientRect();
  const offsetY = 16 * zoom;
  const offsetX = 2 * zoom;
  const x = clamp(e.x, rect.left + offsetX, rect.right - offsetX);
  const y = clamp(e.y, rect.top + offsetY, rect.bottom - offsetY);
  handleNativeRangeAtPoint(x, y);

  if (note.store.readonly) return;

  tryAddCanvasNoteParagraph(anchor, note, std, x, y);
}
