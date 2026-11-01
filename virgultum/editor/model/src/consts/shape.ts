export const DEFAULT_ROUGHNESS = 1.4;

// TODO: need to check the default central area ratio
export const DEFAULT_CENTRAL_AREA_RATIO = 0.3;

export enum ShapeTextFontSize {
  LARGE = 28,
  MEDIUM = 20,
  SMALL = 12,
  XLARGE = 36,
}

export enum ShapeType {
  Rect = "rect",
  Ellipse = "ellipse",
  Diamond = "diamond",
  Triangle = "triangle",

  // Neutral Mermaid renderer shapes
  MermaidAsymmetric = "mermaid-asymmetric",
  MermaidBang = "mermaid-bang",
  MermaidBlockArrow = "mermaid-block-arrow",
  MermaidBolt = "mermaid-bolt",
  MermaidBowRect = "mermaid-bow-rect",
  MermaidBrace = "mermaid-brace",
  MermaidBraceR = "mermaid-brace-r",
  MermaidBraces = "mermaid-braces",
  MermaidCloud = "mermaid-cloud",
  MermaidCherryPick = "mermaid-cherry-pick",
  MermaidCrossCirc = "mermaid-cross-circ",
  MermaidCurvTrap = "mermaid-curv-trap",
  MermaidPerson = "mermaid-person",
  MermaidCylinder = "mermaid-cylinder",
  MermaidDatastore = "mermaid-datastore",
  MermaidDelay = "mermaid-delay",
  MermaidDivRect = "mermaid-div-rect",
  MermaidDoc = "mermaid-doc",
  MermaidDocs = "mermaid-docs",
  MermaidDoubleCircle = "mermaid-double-circle",
  MermaidFCirc = "mermaid-f-circ",
  MermaidFlag = "mermaid-flag",
  MermaidFlipTri = "mermaid-flip-tri",
  MermaidFork = "mermaid-fork",
  MermaidFrCirc = "mermaid-fr-circ",
  MermaidFrRect = "mermaid-fr-rect",
  MermaidHCyl = "mermaid-h-cyl",
  MermaidHexagon = "mermaid-hexagon",
  MermaidHourglass = "mermaid-hourglass",
  MermaidLeanL = "mermaid-lean-l",
  MermaidLeanR = "mermaid-lean-r",
  MermaidLinCyl = "mermaid-lin-cyl",
  MermaidLinDoc = "mermaid-lin-doc",
  MermaidLinRect = "mermaid-lin-rect",
  MermaidNotchPent = "mermaid-notch-pent",
  MermaidNotchRect = "mermaid-notch-rect",
  MermaidOdd = "mermaid-odd",
  MermaidSlRect = "mermaid-sl-rect",
  MermaidSmCirc = "mermaid-sm-circ",
  MermaidStRect = "mermaid-st-rect",
  MermaidStadium = "mermaid-stadium",
  MermaidSubroutine = "mermaid-subroutine",
  MermaidTagDoc = "mermaid-tag-doc",
  MermaidTagRect = "mermaid-tag-rect",
  MermaidText = "mermaid-text",
  MermaidTrapB = "mermaid-trap-b",
  MermaidTrapT = "mermaid-trap-t",
  MermaidWinPane = "mermaid-win-pane",
}

export type ShapeName = ShapeType | "roundedRect";

export const MERMAID_SHAPE_TYPES = [
  ShapeType.MermaidAsymmetric,
  ShapeType.MermaidBang,
  ShapeType.MermaidBlockArrow,
  ShapeType.MermaidBolt,
  ShapeType.MermaidBowRect,
  ShapeType.MermaidBrace,
  ShapeType.MermaidBraceR,
  ShapeType.MermaidBraces,
  ShapeType.MermaidCloud,
  ShapeType.MermaidCherryPick,
  ShapeType.MermaidCrossCirc,
  ShapeType.MermaidCurvTrap,
  ShapeType.MermaidPerson,
  ShapeType.MermaidCylinder,
  ShapeType.MermaidDatastore,
  ShapeType.MermaidDelay,
  ShapeType.MermaidDivRect,
  ShapeType.MermaidDoc,
  ShapeType.MermaidDocs,
  ShapeType.MermaidDoubleCircle,
  ShapeType.MermaidFCirc,
  ShapeType.MermaidFlag,
  ShapeType.MermaidFlipTri,
  ShapeType.MermaidFork,
  ShapeType.MermaidFrCirc,
  ShapeType.MermaidFrRect,
  ShapeType.MermaidHCyl,
  ShapeType.MermaidHexagon,
  ShapeType.MermaidHourglass,
  ShapeType.MermaidLeanL,
  ShapeType.MermaidLeanR,
  ShapeType.MermaidLinCyl,
  ShapeType.MermaidLinDoc,
  ShapeType.MermaidLinRect,
  ShapeType.MermaidNotchPent,
  ShapeType.MermaidNotchRect,
  ShapeType.MermaidOdd,
  ShapeType.MermaidSlRect,
  ShapeType.MermaidSmCirc,
  ShapeType.MermaidStRect,
  ShapeType.MermaidStadium,
  ShapeType.MermaidSubroutine,
  ShapeType.MermaidTagDoc,
  ShapeType.MermaidTagRect,
  ShapeType.MermaidText,
  ShapeType.MermaidTrapB,
  ShapeType.MermaidTrapT,
  ShapeType.MermaidWinPane,
] as const;

export function isMermaidShapeType(type: string): type is ShapeType {
  return (MERMAID_SHAPE_TYPES as readonly string[]).includes(type);
}

export function getShapeName(type: ShapeType, radius: number): ShapeName {
  if (type === ShapeType.Rect && radius > 0) {
    return "roundedRect";
  }
  return type;
}

export function getShapeType(name: ShapeName): ShapeType {
  if (name === "roundedRect") {
    return ShapeType.Rect;
  }
  return name;
}

export function getShapeRadius(name: ShapeName): number {
  if (name === "roundedRect") {
    return 0.1;
  }
  return 0;
}

export enum ShapeStyle {
  General = "General",
  Scribbled = "Scribbled",
}
