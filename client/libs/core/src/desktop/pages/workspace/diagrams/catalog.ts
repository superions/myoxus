import { MERMAID_PRODUCT_TEMPLATES } from "@virgultum/block-mermaid";

export const DIAGRAM_CATALOG_CATEGORIES = [
  "popular",
  "all",
  "processes",
  "software",
  "planning",
  "data",
] as const;

export type DiagramCatalogCategory =
  (typeof DIAGRAM_CATALOG_CATEGORIES)[number];

export type DiagramCatalogEntry = {
  readonly category: Exclude<DiagramCatalogCategory, "all" | "popular">;
  readonly descriptionKey: `com.myoxus.diagrams.catalog.type.${string}.description`;
  readonly format: "bpmn" | "mermaid";
  readonly id: string;
  readonly label: string;
  readonly popular?: boolean;
  readonly preview: string;
} & (
  | {
      readonly format: "bpmn";
      readonly source?: never;
      readonly sourceOnly?: never;
    }
  | {
      readonly format: "mermaid";
      readonly source: string;
      readonly sourceOnly?: true;
      readonly edgelessPlacement?: "native";
    }
);

function mermaidSource(templateId: string) {
  const template = MERMAID_PRODUCT_TEMPLATES.find(
    (candidate) => candidate.id === templateId,
  );
  if (!template) {
    throw new Error(`Missing Mermaid catalog template: ${templateId}`);
  }
  return template.source;
}

/**
 * User-facing diagram vocabulary. Engine variants such as ELK, v2 and beta
 * syntax stay implementation details; each semantic diagram appears once.
 */
const DIAGRAM_CATALOG_ENTRIES = [
  {
    id: "bpmn",
    label: "BPMN",
    format: "bpmn",
    category: "processes",
    popular: true,
    preview: "bpmn",
    descriptionKey: "com.myoxus.diagrams.catalog.type.bpmn.description",
  },
  {
    id: "flowchart",
    label: "Flowchart",
    format: "mermaid",
    category: "processes",
    popular: true,
    preview: "flowchart",
    source: mermaidSource("flowchart-basic"),
    edgelessPlacement: "native",
    descriptionKey: "com.myoxus.diagrams.catalog.type.flowchart.description",
  },
  {
    id: "swimlanes",
    label: "Swimlanes",
    format: "mermaid",
    category: "processes",
    preview: "swimlanes",
    source:
      "swimlane-beta LR\n  subgraph Requester\n    submit[Submit request]\n    receive[Receive result]\n  end\n  subgraph Review\n    check[Review request]\n    decide{Approved?}\n  end\n  submit --> check --> decide\n  decide -->|Yes| receive\n  decide -->|No| submit",
    descriptionKey: "com.myoxus.diagrams.catalog.type.swimlanes.description",
  },
  {
    id: "sequence",
    label: "Sequence",
    format: "mermaid",
    category: "processes",
    popular: true,
    preview: "sequence",
    source: mermaidSource("sequence-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.sequence.description",
  },
  {
    id: "state",
    label: "State",
    format: "mermaid",
    category: "processes",
    preview: "state",
    source: mermaidSource("state-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.state.description",
  },
  {
    id: "journey",
    label: "User Journey",
    format: "mermaid",
    category: "processes",
    preview: "journey",
    source: mermaidSource("journey-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.journey.description",
  },
  {
    id: "event-modeling",
    label: "Event Modeling",
    format: "mermaid",
    category: "processes",
    preview: "event-modeling",
    source:
      "eventmodeling\n  tf 01 ui RequestForm\n  tf 02 cmd SubmitRequest\n  tf 03 evt RequestSubmitted\n  tf 04 rmo RequestStatus",
    descriptionKey:
      "com.myoxus.diagrams.catalog.type.event-modeling.description",
  },
  {
    id: "architecture",
    label: "Architecture",
    format: "mermaid",
    category: "software",
    popular: true,
    preview: "architecture",
    source: mermaidSource("architecture-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.architecture.description",
  },
  {
    id: "c4",
    label: "C4",
    format: "mermaid",
    category: "software",
    preview: "architecture",
    source: mermaidSource("c4-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.c4.description",
  },
  {
    id: "class",
    label: "Class",
    format: "mermaid",
    category: "software",
    preview: "class",
    source: mermaidSource("class-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.class.description",
  },
  {
    id: "er",
    label: "Entity Relationship",
    format: "mermaid",
    category: "software",
    popular: true,
    preview: "er",
    source: mermaidSource("er-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.er.description",
  },
  {
    id: "requirement",
    label: "Requirement",
    format: "mermaid",
    category: "software",
    preview: "requirement",
    source: mermaidSource("requirement-basic"),
    edgelessPlacement: "native",
    descriptionKey: "com.myoxus.diagrams.catalog.type.requirement.description",
  },
  {
    id: "git-graph",
    label: "Git Graph",
    format: "mermaid",
    category: "software",
    preview: "git-graph",
    source: mermaidSource("gitgraph-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.git-graph.description",
  },
  {
    id: "packet",
    label: "Packet",
    format: "mermaid",
    category: "software",
    preview: "packet",
    source: mermaidSource("packet-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.packet.description",
  },
  {
    id: "gantt",
    label: "Gantt",
    format: "mermaid",
    category: "planning",
    popular: true,
    preview: "gantt",
    source: mermaidSource("gantt-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.gantt.description",
  },
  {
    id: "timeline",
    label: "Timeline",
    format: "mermaid",
    category: "planning",
    popular: true,
    preview: "timeline",
    source: mermaidSource("timeline-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.timeline.description",
  },
  {
    id: "kanban",
    label: "Kanban",
    format: "mermaid",
    category: "planning",
    preview: "kanban",
    source: mermaidSource("kanban-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.kanban.description",
  },
  {
    id: "mindmap",
    label: "Mindmap",
    format: "mermaid",
    category: "planning",
    popular: true,
    preview: "mindmap",
    source: mermaidSource("mindmap-basic"),
    edgelessPlacement: "native",
    descriptionKey: "com.myoxus.diagrams.catalog.type.mindmap.description",
  },
  {
    id: "block",
    label: "Block",
    format: "mermaid",
    category: "planning",
    preview: "block",
    source: mermaidSource("block-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.block.description",
  },
  {
    id: "tree-view",
    label: "TreeView",
    format: "mermaid",
    category: "planning",
    preview: "tree-view",
    source:
      "treeView-beta\n  my-project/\n    src/\n      index.ts\n    tests/\n      app.spec.ts\n    README.md",
    descriptionKey: "com.myoxus.diagrams.catalog.type.tree-view.description",
  },
  {
    id: "wardley",
    label: "Wardley",
    format: "mermaid",
    category: "planning",
    preview: "wardley",
    source:
      "wardley-beta\n  title Product strategy\n  anchor Customer [0.90, 0.95]\n  component Application [0.70, 0.70]\n  component Platform [0.45, 0.55]\n  component Infrastructure [0.25, 0.30]\n  Customer -> Application\n  Application -> Platform\n  Platform -> Infrastructure",
    descriptionKey: "com.myoxus.diagrams.catalog.type.wardley.description",
  },
  {
    id: "cynefin",
    label: "Cynefin",
    format: "mermaid",
    category: "planning",
    preview: "cynefin",
    source:
      'cynefin-beta\n  title Decision context\n  complex\n    "Explore options"\n  complicated\n    "Expert analysis"\n  clear\n    "Apply procedure"\n  chaotic\n    "Stabilize now"\n  confusion\n    "Classify issue"',
    descriptionKey: "com.myoxus.diagrams.catalog.type.cynefin.description",
  },
  {
    id: "ishikawa",
    label: "Ishikawa",
    format: "mermaid",
    category: "planning",
    preview: "ishikawa",
    source:
      "ishikawa-beta\n  Delayed delivery\n    Process\n      Unclear handoff\n      Missing review\n    People\n      Capacity gap\n    Tools\n      Slow build",
    descriptionKey: "com.myoxus.diagrams.catalog.type.ishikawa.description",
  },
  {
    id: "pie",
    label: "Pie",
    format: "mermaid",
    category: "data",
    preview: "pie",
    source: mermaidSource("pie-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.pie.description",
  },
  {
    id: "quadrant",
    label: "Quadrant",
    format: "mermaid",
    category: "data",
    preview: "quadrant",
    source: mermaidSource("quadrant-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.quadrant.description",
  },
  {
    id: "radar",
    label: "Radar",
    format: "mermaid",
    category: "data",
    preview: "radar",
    source: mermaidSource("radar-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.radar.description",
  },
  {
    id: "sankey",
    label: "Sankey",
    format: "mermaid",
    category: "data",
    preview: "sankey",
    source: mermaidSource("sankey-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.sankey.description",
  },
  {
    id: "xy-chart",
    label: "XY Chart",
    format: "mermaid",
    category: "data",
    preview: "xy-chart",
    source: mermaidSource("xychart-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.xy-chart.description",
  },
  {
    id: "treemap",
    label: "Treemap",
    format: "mermaid",
    category: "data",
    preview: "treemap",
    source: mermaidSource("treemap-basic"),
    descriptionKey: "com.myoxus.diagrams.catalog.type.treemap.description",
  },
  {
    id: "venn",
    label: "Venn",
    format: "mermaid",
    category: "data",
    preview: "venn",
    source:
      'venn-beta\n  title "Team overlap"\n  set Product\n  set Engineering\n  union Product,Engineering["Shared work"]',
    descriptionKey: "com.myoxus.diagrams.catalog.type.venn.description",
  },
] as const satisfies ReadonlyArray<
  DiagramCatalogEntry & { readonly sourceOnly?: never }
>;

export type DiagramCatalogId = (typeof DIAGRAM_CATALOG_ENTRIES)[number]["id"];

export type DiagramCatalogMaturity = "alpha" | "beta";

/**
 * Product-facing maturity is intentionally conservative: newly catalogued
 * diagram types remain Alpha until they are explicitly promoted.
 */
export function getDiagramCatalogMaturity(
  id: DiagramCatalogId,
): DiagramCatalogMaturity {
  return id === "flowchart" ? "beta" : "alpha";
}

export const DIAGRAM_CATALOG = DIAGRAM_CATALOG_ENTRIES.map((entry) => {
  if (entry.format !== "mermaid") return entry;
  const template = MERMAID_PRODUCT_TEMPLATES.find(
    (candidate) => candidate.source === entry.source,
  );
  return template ? entry : { ...entry, sourceOnly: true as const };
}) as ReadonlyArray<DiagramCatalogEntry & { readonly id: DiagramCatalogId }>;

export function getDiagramCatalogEntries(category: DiagramCatalogCategory) {
  if (category === "all") return DIAGRAM_CATALOG;
  if (category === "popular") {
    return DIAGRAM_CATALOG.filter(
      (entry) => "popular" in entry && entry.popular,
    );
  }
  return DIAGRAM_CATALOG.filter((entry) => entry.category === category);
}

export function resolveCatalogSelection(
  category: DiagramCatalogCategory,
  selectedId: DiagramCatalogId,
): DiagramCatalogId {
  const visible = getDiagramCatalogEntries(category);
  return visible.some((entry) => entry.id === selectedId)
    ? selectedId
    : (visible[0]?.id ?? "flowchart");
}

export function recentDiagramDocs<
  T extends {
    readonly meta$: {
      readonly value: { createDate?: number; updatedDate?: number };
    };
  },
>(docs: ReadonlyArray<T>, limit = 10) {
  return [...docs]
    .sort((left, right) => {
      const leftDate =
        left.meta$.value.updatedDate ?? left.meta$.value.createDate ?? 0;
      const rightDate =
        right.meta$.value.updatedDate ?? right.meta$.value.createDate ?? 0;
      return rightDate - leftDate;
    })
    .slice(0, limit);
}
