import {
  CodeLayoutPainterExtension,
  ImageLayoutPainterExtension,
  ListLayoutPainterExtension,
  NoteLayoutPainterExtension,
  ParagraphLayoutPainterExtension,
  ViewportLayoutPainter,
} from "@virgultum/editor/painters";

new ViewportLayoutPainter([
  ParagraphLayoutPainterExtension,
  ListLayoutPainterExtension,
  NoteLayoutPainterExtension,
  CodeLayoutPainterExtension,
  ImageLayoutPainterExtension,
]);
