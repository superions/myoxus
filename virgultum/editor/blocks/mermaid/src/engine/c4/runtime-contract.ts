// SPDX-License-Identifier: AGPL-3.0-or-later

import type { C4FieldValue, MermaidC4Argument } from "./model.js";

/** svgDraw reparses truthy DB values with native parseInt, including string-slot overrides. */
export function c4RelationshipLabelOffset(value: C4FieldValue | undefined) {
  return value ? Number.parseInt(String(value)) : 0;
}

export const C4_HEADERS = [
  "C4Component",
  "C4Container",
  "C4Context",
  "C4Deployment",
  "C4Dynamic",
] as const;
export type MermaidC4Header = (typeof C4_HEADERS)[number];
export const HEADERS: ReadonlySet<string> = new Set(C4_HEADERS);

/** Argument keys belong to the receiving DB slot; they are not global options. */
export function optionalArgumentValue(
  args: readonly MermaidC4Argument[],
  index: number,
  names: readonly string[],
) {
  const argument = args[index];
  if (!argument) return undefined;
  return (!argument.named && !argument.key) || argument.key === names[0]
    ? argument.value
    : undefined;
}

export function argumentValue(
  args: readonly MermaidC4Argument[],
  index: number,
  names: readonly string[],
) {
  return optionalArgumentValue(args, index, names) ?? "";
}

export const mermaidC4ArgumentValue = argumentValue;
export const mermaidC4OptionalArgumentValue = optionalArgumentValue;

/** UpdateLayoutConfig reads the value of each slot and deliberately ignores its key. */
export function c4LayoutRowValue(
  args: readonly MermaidC4Argument[],
  index: 0 | 1,
) {
  const value = Number.parseInt(args[index]?.value ?? "");
  return value >= 1 ? value : undefined;
}

export function elementArgumentIndexes(kind: string) {
  const technology = /^(?:Component|Container)/.test(kind);
  return technology
    ? { description: 3, link: 6, sprite: 4, tags: 5, technology: 2 }
    : { description: 2, link: 5, sprite: 3, tags: 4, technology: -1 };
}

export function boundaryArgumentIndexes(kind: string) {
  if (
    kind === "Enterprise_Boundary" ||
    kind === "System_Boundary" ||
    kind === "Container_Boundary"
  ) {
    return { description: -1, link: 3, sprite: -1, tags: 2, type: -1 };
  }
  if (/^(?:Deployment_Node|Node(?:_[LR])?)$/.test(kind)) {
    return { description: 3, link: 6, sprite: 4, tags: 5, type: 2 };
  }
  return { description: -1, link: 4, sprite: -1, tags: 3, type: 2 };
}

export function relationshipArgumentIndexes(kind: string) {
  const offset = kind === "RelIndex" ? 1 : 0;
  return {
    description: offset + 4,
    from: offset,
    label: offset + 2,
    link: offset + 7,
    sprite: offset + 5,
    tags: offset + 6,
    technology: offset + 3,
    to: offset + 1,
  };
}

export type MermaidC4CallContract = {
  readonly category: "element" | "boundary" | "relationship" | "update";
  readonly slots: readonly MermaidC4ArgumentField[];
  readonly required: readonly number[];
  readonly ignoredSlots?: readonly number[];
  readonly nativeType?: string;
  readonly injectedType?: "ENTERPRISE" | "SYSTEM" | "CONTAINER";
};

const elementTypes = {
  Person: "person",
  Person_Ext: "external_person",
  System: "system",
  SystemDb: "system_db",
  SystemQueue: "system_queue",
  System_Ext: "external_system",
  SystemDb_Ext: "external_system_db",
  SystemQueue_Ext: "external_system_queue",
  Container: "container",
  ContainerDb: "container_db",
  ContainerQueue: "container_queue",
  Container_Ext: "external_container",
  ContainerDb_Ext: "external_container_db",
  ContainerQueue_Ext: "external_container_queue",
  Component: "component",
  ComponentDb: "component_db",
  ComponentQueue: "component_queue",
  Component_Ext: "external_component",
  ComponentDb_Ext: "external_component_db",
  ComponentQueue_Ext: "external_component_queue",
} as const;
export type MermaidC4ElementKind = keyof typeof elementTypes;
export const C4_ELEMENT_KINDS = Object.keys(
  elementTypes,
) as MermaidC4ElementKind[];
export function isC4ElementKind(kind: string): kind is MermaidC4ElementKind {
  return Object.hasOwn(elementTypes, kind);
}
export type MermaidC4RenderShape =
  "person" | "rounded" | "cylinder" | "h-cyl" | "fr-rect";
const shapeKeywords: Readonly<Record<string, MermaidC4RenderShape>> = {
  person: "person",
  box: "rounded",
  rounded: "rounded",
  cylinder: "cylinder",
  database: "cylinder",
  db: "cylinder",
  queue: "h-cyl",
  pipe: "h-cyl",
  component: "fr-rect",
};
export const C4_SHAPE_KEYWORDS = Object.keys(shapeKeywords);
const shapeKeyword = (value: string | undefined) =>
  value && Object.hasOwn(shapeKeywords, value.toLowerCase())
    ? shapeKeywords[value.toLowerCase()]
    : undefined;
/** Only tag tokens are trimmed. Shape/sprite use the exact native keywords. */
export function resolveC4RenderShape(value: {
  kind: string;
  shape?: string;
  sprite?: string;
  tags?: string;
}): MermaidC4RenderShape {
  const override = shapeKeyword(value.shape) ?? shapeKeyword(value.sprite);
  if (override) return override;
  for (const tag of value.tags?.split(",") ?? []) {
    const tagged = shapeKeyword(tag.trim());
    if (tagged) return tagged;
  }
  const kind = isC4ElementKind(value.kind) ? elementTypes[value.kind] : "";
  if (kind === "person" || kind === "external_person") return "person";
  if (kind.endsWith("_db")) return "cylinder";
  if (kind.endsWith("_queue")) return "h-cyl";
  return "rounded";
}

const boundaryTypes = {
  Boundary: undefined,
  Enterprise_Boundary: "ENTERPRISE",
  System_Boundary: "SYSTEM",
  Container_Boundary: "CONTAINER",
  Deployment_Node: "node",
  Node: "node",
  Node_L: "nodeL",
  Node_R: "nodeR",
} as const;
export type MermaidC4BoundaryKind = keyof typeof boundaryTypes;
export const C4_BOUNDARY_KINDS = Object.keys(
  boundaryTypes,
) as MermaidC4BoundaryKind[];
export function isC4BoundaryKind(kind: string): kind is MermaidC4BoundaryKind {
  return Object.hasOwn(boundaryTypes, kind);
}

const relationshipTypes = {
  Rel: "rel",
  BiRel: "birel",
  Rel_Up: "rel_u",
  Rel_U: "rel_u",
  Rel_Down: "rel_d",
  Rel_D: "rel_d",
  Rel_Left: "rel_l",
  Rel_L: "rel_l",
  Rel_Right: "rel_r",
  Rel_R: "rel_r",
  Rel_Back: "rel_b",
  RelIndex: "rel",
} as const;
export type MermaidC4RelationshipKind = keyof typeof relationshipTypes;
export const C4_RELATIONSHIP_KINDS = Object.keys(
  relationshipTypes,
) as MermaidC4RelationshipKind[];
export function isC4RelationshipKind(
  kind: string,
): kind is MermaidC4RelationshipKind {
  return Object.hasOwn(relationshipTypes, kind);
}

const elementSlots = [
  "alias",
  "label",
  "descr",
  "sprite",
  "tags",
  "link",
] as const;
const technologySlots = [
  "alias",
  "label",
  "techn",
  "descr",
  "sprite",
  "tags",
  "link",
] as const;
const relationshipSlots = [
  "from",
  "to",
  "label",
  "techn",
  "descr",
  "sprite",
  "tags",
  "link",
] as const;
const updateSlots = {
  UpdateElementStyle: [
    "elementName",
    "bgColor",
    "fontColor",
    "borderColor",
    "shadowing",
    "shape",
    "sprite",
    "techn",
    "legendText",
    "legendSprite",
  ],
  UpdateRelStyle: [
    "from",
    "to",
    "textColor",
    "lineColor",
    "offsetX",
    "offsetY",
  ],
  UpdateLayoutConfig: ["c4ShapeInRow", "c4BoundaryInRow"],
} as const;

export type MermaidC4ArgumentField =
  | (typeof elementSlots)[number]
  | (typeof technologySlots)[number]
  | (typeof relationshipSlots)[number]
  | (typeof updateSlots)[keyof typeof updateSlots][number]
  | "type"
  | "index";

/** Mermaid 11.17.2's five headers consume this same grammar and DB contract. */
export const C4_CALLS: Readonly<Record<string, MermaidC4CallContract>> =
  Object.fromEntries([
    ...Object.entries(elementTypes).map(([kind, nativeType]) => [
      kind,
      {
        category: "element",
        nativeType,
        required: [0, 1],
        slots: /^(?:Container|Component)/.test(kind)
          ? technologySlots
          : elementSlots,
      },
    ]),
    ...Object.entries(boundaryTypes).map(([kind, type]) => [
      kind,
      {
        category: "boundary",
        required: [0, 1],
        ...(type && /^(?:ENTERPRISE|SYSTEM|CONTAINER)$/.test(type)
          ? {
              injectedType: type,
              slots: ["alias", "label", "tags", "link"],
            }
          : {
              nativeType: type,
              ignoredSlots: type ? [4] : [],
              slots: type
                ? ["alias", "label", "type", "descr", "sprite", "tags", "link"]
                : ["alias", "label", "type", "tags", "link"],
            }),
      },
    ]),
    ...Object.entries(relationshipTypes).map(([kind, nativeType]) => [
      kind,
      {
        category: "relationship",
        nativeType,
        required: kind === "RelIndex" ? [1, 2, 3] : [0, 1, 2],
        slots:
          kind === "RelIndex"
            ? ["index", ...relationshipSlots]
            : relationshipSlots,
      },
    ]),
    ...Object.entries(updateSlots).map(([kind, slots]) => [
      kind,
      {
        category: "update",
        slots,
        required:
          kind === "UpdateElementStyle"
            ? [0]
            : kind === "UpdateRelStyle"
              ? [0, 1]
              : [],
      },
    ]),
  ] as [string, MermaidC4CallContract][]);

export const ELEMENT_KINDS: ReadonlySet<string> = new Set(
  Object.keys(elementTypes),
);
export const BOUNDARY_KINDS: ReadonlySet<string> = new Set(
  Object.keys(boundaryTypes),
);
export const RELATIONSHIP_KINDS: ReadonlySet<string> = new Set(
  Object.keys(relationshipTypes),
);
export const UPDATE_KINDS: ReadonlySet<string> = new Set(
  Object.keys(updateSlots),
);

export const C4_METADATA = {
  title: { prefix: "title ", terminators: ["#", ";", "\n"] },
  accessibilityTitle: { prefix: "accTitle:", nativeSetterDefect: "setTitle" },
  accessibilityDescription: {
    prefixes: ["accDescr:", "accDescr {", "accDescription "],
  },
} as const;

export const C4_PREAMBLE = {
  frontmatter: { title: "title", configuration: "config" },
  initializationDirective: "init",
  commentPrefix: "%%",
} as const;

// These are authored config values. Runtime Font calculator functions are not source options.
export const C4_CONFIG_GEOMETRY = [
  "diagramMarginX",
  "diagramMarginY",
  "c4ShapeMargin",
  "c4ShapePadding",
  "width",
  "height",
  "boxMargin",
  "nextLinePaddingX",
  "wrapPadding",
  "useMaxWidth",
  "wrap",
] as const;
export const C4_CONFIG_FONT_OWNERS = [
  ...Object.values(elementTypes),
  "boundary",
  "message",
] as const;
export const C4_CONFIG_FONT_FIELDS = [
  "FontSize",
  "FontFamily",
  "FontWeight",
] as const;
export const C4_CONFIG_COLOR_FIELDS = ["_bg_color", "_border_color"] as const;
// Native row getters use UpdateLayoutConfig, even when similarly named config keys exist.
export const C4_CONFIG_IGNORED_ROW_FIELDS = [
  "c4ShapeInRow",
  "c4BoundaryInRow",
] as const;

export const C4_CONFIG_BOOLEAN_FIELDS = ["useMaxWidth", "wrap"] as const;
export const C4_CONFIG_GENERIC_FONTS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
] as const;
export type MermaidC4Config = Partial<
  Record<
    Exclude<
      (typeof C4_CONFIG_GEOMETRY)[number],
      (typeof C4_CONFIG_BOOLEAN_FIELDS)[number]
    >,
    number
  > &
    Record<(typeof C4_CONFIG_BOOLEAN_FIELDS)[number], boolean> & {
      fontFamily: string;
      fontSize: string | number;
      fontWeight: string | number;
    } & Record<`${(typeof C4_CONFIG_FONT_OWNERS)[number]}FontFamily`, string> &
    Record<
      `${(typeof C4_CONFIG_FONT_OWNERS)[number]}${"FontSize" | "FontWeight"}`,
      string | number
    > &
    Record<
      `${(typeof elementTypes)[keyof typeof elementTypes]}${(typeof C4_CONFIG_COLOR_FIELDS)[number]}`,
      string
    >
>;

export function c4RequiredArgumentIssues(
  kind: string,
  args: readonly MermaidC4Argument[],
) {
  // Empty positional strings reach the DB. Final alias/endpoint validity belongs
  // to replay: a later named assignment can replace an initially empty identity.
  const contract = C4_CALLS[kind];
  if (!contract) return [];
  return contract.required.flatMap((index) => {
    const argument = args[index];
    return !argument || argument.named || argument.key
      ? [
          {
            index,
            field: contract.slots[index],
            kind:
              argument?.named || argument?.key
                ? ("named" as const)
                : ("empty" as const),
          },
        ]
      : [];
  });
}

export function c4Quote(value: string) {
  return `"${value.replaceAll('"', "#quot;")}"`;
}

/** Required values are plain DB strings; optional named keys stay at their exact slot. */
/** The native key state ends at the first equals sign; it cannot be part of a key. */
export function isC4ArgumentKey(key: string) {
  return !key.includes("=");
}

export function c4CallSource(kind: string, args: readonly MermaidC4Argument[]) {
  const contract = C4_CALLS[kind];
  if (!contract) throw new Error(`Unsupported C4 call: ${kind}`);
  if (!args.length || c4RequiredArgumentIssues(kind, args).length)
    throw new Error(`Invalid required C4 arguments: ${kind}`);
  if (args.some((argument) => !isC4ArgumentKey(argument.key)))
    throw new Error("Invalid C4 named-argument key");
  return `${kind}(${args
    .map((argument, index) => {
      if (argument.named || argument.key) {
        // Jison requires a lexical byte in named strings, then trims it.
        return `$${argument.key}=${c4Quote(argument.value || " ")}`;
      }
      if (!argument.value) return c4Quote("");
      const aliasSlot = [
        "alias",
        "from",
        "to",
        "elementName",
        "index",
      ].includes(contract.slots[index]);
      return aliasSlot &&
        index < args.length - 1 &&
        /^(?:[A-Za-z_]\w*|\d+)$/.test(argument.value)
        ? argument.value
        : c4Quote(argument.value);
    })
    // The attribute lexer cannot skip whitespace before a terminal RPAREN.
    .join(", ")
    .trimEnd()})`;
}
