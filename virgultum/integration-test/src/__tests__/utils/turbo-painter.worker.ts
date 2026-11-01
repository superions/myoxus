import { ImageLayoutPainterExtension } from "@virgultum/block-image/turbo-painter";
import { ListLayoutPainterExtension } from "@virgultum/block-list/turbo-painter";
import { NoteLayoutPainterExtension } from "@virgultum/block-note/turbo-painter";
import { ParagraphLayoutPainterExtension } from "@virgultum/block-paragraph/turbo-painter";
import { ViewportLayoutPainter } from "@virgultum/gfx-turbo-renderer/painter";

new ViewportLayoutPainter([
  ParagraphLayoutPainterExtension,
  ListLayoutPainterExtension,
  NoteLayoutPainterExtension,
  ImageLayoutPainterExtension,
]);
