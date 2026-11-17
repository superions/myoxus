import { MERMAID_SHAPE_TYPES, type ShapeType } from "../../../consts/shape.js";
import { diamond } from "./diamond.js";
import { ellipse } from "./ellipse.js";
import { mermaidShape } from "./mermaid.js";
import { rect } from "./rect.js";
import { triangle } from "./triangle.js";

export const shapeMethods: Record<ShapeType, typeof rect> = {
  rect,
  triangle,
  ellipse,
  diamond,
} as unknown as Record<ShapeType, typeof rect>;

for (const type of MERMAID_SHAPE_TYPES) {
  shapeMethods[type] = mermaidShape(type);
}

export {
  mermaidContourPoints,
  mermaidPersonGeometry,
  mermaidSoftShapePath,
} from "./mermaid.js";
