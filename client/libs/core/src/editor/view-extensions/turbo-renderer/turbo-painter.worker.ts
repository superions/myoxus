import { CodeLayoutPainterExtension } from "@virgultum/editor/blocks/code";
import { ImageLayoutPainterExtension } from "@virgultum/editor/blocks/image";
import { ListLayoutPainterExtension } from "@virgultum/editor/blocks/list";
import { NoteLayoutPainterExtension } from "@virgultum/editor/blocks/note";
import { ParagraphLayoutPainterExtension } from "@virgultum/editor/blocks/paragraph";
import { ViewportLayoutPainter } from "@virgultum/editor/gfx/turbo-renderer";

new ViewportLayoutPainter([
  ParagraphLayoutPainterExtension,
  ListLayoutPainterExtension,
  NoteLayoutPainterExtension,
  CodeLayoutPainterExtension,
  ImageLayoutPainterExtension,
]);
