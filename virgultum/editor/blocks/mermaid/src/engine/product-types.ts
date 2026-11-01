import type { MermaidDiagramType } from "./diagram-types.js";

export const MERMAID_PRODUCT_DIAGRAM_TYPES = [
  "architecture",
  "block",
  "c4",
  "classDiagram",
  "classDiagram-v2",
  "erDiagram",
  "flowchart",
  "flowchart-elk",
  "gantt",
  "gitGraph",
  "journey",
  "kanban",
  "mindmap",
  "packet",
  "pie",
  "quadrantChart",
  "radar",
  "requirementDiagram",
  "sankey",
  "sequenceDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "timeline",
  "treemap",
  "xychart",
] as const satisfies ReadonlyArray<Exclude<MermaidDiagramType, "unknown">>;

export type MermaidProductDiagramType =
  (typeof MERMAID_PRODUCT_DIAGRAM_TYPES)[number];

export const MERMAID_PRODUCT_CATEGORY_IDS = [
  "processes",
  "software",
  "planning",
  "data",
] as const;
export type MermaidProductCategory =
  (typeof MERMAID_PRODUCT_CATEGORY_IDS)[number];

export type MermaidProductDiagramSpec = {
  readonly diagramType: MermaidProductDiagramType;
  readonly category: MermaidProductCategory;
  readonly docUrl: string;
  readonly label: string;
  readonly templateId: string;
  readonly templateSource: string;
};

export type MermaidProductFamilyId =
  | "architecture"
  | "c4"
  | "block"
  | "flowchart"
  | "gitgraph"
  | "gantt"
  | "requirement"
  | "mindmap"
  | "pie"
  | "kanban"
  | "journey"
  | "quadrant"
  | "packet"
  | "radar"
  | "sankey"
  | "treemap"
  | "timeline"
  | "class"
  | "er"
  | "sequence"
  | "state"
  | "xy";

export const MERMAID_PRODUCT_DIAGRAM_SPECS = [
  {
    diagramType: "c4",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/c4.html",
    label: "C4",
    templateId: "c4-basic",
    templateSource:
      'C4Context\n  Person(user, "User")\n  System(myoxus, "Myoxus")\n  Rel(user, myoxus, "Uses")',
  },
  {
    diagramType: "architecture",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/architecture.html",
    label: "Architecture",
    templateId: "architecture-basic",
    templateSource:
      "architecture-beta\n  group web(icon)[Web]\n  service app(icon)[App] in web\n  service db(icon)[DB] in web\n  app:R --> L:db",
  },
  {
    diagramType: "block",
    category: "planning",
    docUrl: "https://mermaid.js.org/syntax/block.html",
    label: "Block",
    templateId: "block-basic",
    templateSource: "block-beta\n  A --> B\n  B --> C",
  },
  {
    diagramType: "flowchart",
    category: "processes",
    docUrl: "https://mermaid.js.org/syntax/flowchart.html",
    label: "Flowchart",
    templateId: "flowchart-basic",
    templateSource:
      "flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]\n  B -->|No| D[Retry]",
  },
  {
    diagramType: "flowchart-elk",
    category: "processes",
    docUrl: "https://mermaid.js.org/syntax/flowchart.html",
    label: "Flowchart ELK",
    templateId: "flowchart-elk-basic",
    templateSource:
      "flowchart-elk TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]\n  B -->|No| D[Retry]",
  },
  {
    diagramType: "erDiagram",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/entityRelationshipDiagram.html",
    label: "ER",
    templateId: "er-basic",
    templateSource:
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  CUSTOMER {\n    string id\n    string name\n  }\n  ORDER {\n    string id\n  }",
  },
  {
    diagramType: "gantt",
    category: "planning",
    docUrl: "https://mermaid.js.org/syntax/gantt.html",
    label: "Gantt",
    templateId: "gantt-basic",
    templateSource:
      "gantt\n  title Build Plan\n  dateFormat YYYY-MM-DD\n  section Work\n  Design :a1, 2026-01-01, 3d\n  Build :after a1, 5d",
  },
  {
    diagramType: "gitGraph",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/gitgraph.html",
    label: "Git graph",
    templateId: "gitgraph-basic",
    templateSource:
      'gitGraph\n  commit id:"Initial"\n  branch feature\n  checkout feature\n  commit id:"Feature"',
  },
  {
    diagramType: "journey",
    category: "processes",
    docUrl: "https://mermaid.js.org/syntax/userJourney.html",
    label: "Journey",
    templateId: "journey-basic",
    templateSource:
      "journey\n  title User Journey\n  section Start\n    Open workspace: 5: User\n    Create diagram: 4: User",
  },
  {
    diagramType: "kanban",
    category: "planning",
    docUrl: "https://mermaid.js.org/syntax/kanban.html",
    label: "Kanban",
    templateId: "kanban-basic",
    templateSource:
      "kanban\n  todo[To Do]\n    t1[Spec]\n  done[Done]\n    t2[Test]",
  },
  {
    diagramType: "mindmap",
    category: "planning",
    docUrl: "https://mermaid.js.org/syntax/mindmap.html",
    label: "Mindmap",
    templateId: "mindmap-basic",
    templateSource:
      "mindmap\n  root((Myoxus))\n    Documents\n    Diagrams\n    Export",
  },
  {
    diagramType: "packet",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/packet.html",
    label: "Packet",
    templateId: "packet-basic",
    templateSource: 'packet\n  0-3: "Version"\n  4-7: "IHL"\n  8-15: "Length"',
  },
  {
    diagramType: "pie",
    category: "data",
    docUrl: "https://mermaid.js.org/syntax/pie.html",
    label: "Pie",
    templateId: "pie-basic",
    templateSource:
      'pie showData\n  title Share\n  "A" : 45\n  "B" : 30\n  "C" : 25',
  },
  {
    diagramType: "quadrantChart",
    category: "data",
    docUrl: "https://mermaid.js.org/syntax/quadrantChart.html",
    label: "Quadrant",
    templateId: "quadrant-basic",
    templateSource:
      "quadrantChart\n  title Priority\n  x-axis Low impact --> High impact\n  y-axis Low effort --> High effort\n  Project A : [0.8, 0.3]",
  },
  {
    diagramType: "radar",
    category: "data",
    docUrl: "https://mermaid.js.org/syntax/radar.html",
    label: "Radar",
    templateId: "radar-basic",
    templateSource:
      "radar-beta\n  axis Speed, Quality, Cost\n  curve Alpha {3,4,2}",
  },
  {
    diagramType: "requirementDiagram",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/requirementDiagram.html",
    label: "Requirement",
    templateId: "requirement-basic",
    templateSource:
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: User can export\n    risk: medium\n  }",
  },
  {
    diagramType: "sankey",
    category: "data",
    docUrl: "https://mermaid.js.org/syntax/sankey.html",
    label: "Sankey",
    templateId: "sankey-basic",
    templateSource: "sankey\n  Source, Process, 10\n  Process, Output, 8",
  },
  {
    diagramType: "sequenceDiagram",
    category: "processes",
    docUrl: "https://mermaid.js.org/syntax/sequenceDiagram.html",
    label: "Sequence",
    templateId: "sequence-basic",
    templateSource:
      "sequenceDiagram\n  participant User\n  participant Myoxus\n  User->>Myoxus: Request\n  Myoxus-->>User: Response",
  },
  {
    diagramType: "stateDiagram-v2",
    category: "processes",
    docUrl: "https://mermaid.js.org/syntax/stateDiagram.html",
    label: "State",
    templateId: "state-basic",
    templateSource:
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Active\n  Active --> [*]",
  },
  {
    diagramType: "stateDiagram",
    category: "processes",
    docUrl: "https://mermaid.js.org/syntax/stateDiagram.html",
    label: "State legacy",
    templateId: "state-legacy-basic",
    templateSource:
      "stateDiagram\n  [*] --> Idle\n  Idle --> Active\n  Active --> [*]",
  },
  {
    diagramType: "timeline",
    category: "planning",
    docUrl: "https://mermaid.js.org/syntax/timeline.html",
    label: "Timeline",
    templateId: "timeline-basic",
    templateSource:
      "timeline\n  title Roadmap\n  2026 : Mermaid complete\n  2027 : Export polish",
  },
  {
    diagramType: "treemap",
    category: "data",
    docUrl: "https://mermaid.js.org/syntax/treemap.html",
    label: "Treemap",
    templateId: "treemap-basic",
    templateSource: 'treemap-beta\n"Root"\n  "A": 40\n  "B": 60',
  },
  {
    diagramType: "xychart",
    category: "data",
    docUrl: "https://mermaid.js.org/syntax/xyChart.html",
    label: "XY chart",
    templateId: "xychart-basic",
    templateSource:
      'xychart-beta\ntitle "Revenue"\nx-axis [Jan, Feb]\ny-axis "USD" 0 --> 10\nbar [4, 8]',
  },
  {
    diagramType: "classDiagram",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/classDiagram.html",
    label: "Class",
    templateId: "class-basic",
    templateSource:
      "classDiagram\n  class Document {\n    +title\n    +diagramSource\n  }\n  Document --> MermaidDiagram",
  },
  {
    diagramType: "classDiagram-v2",
    category: "software",
    docUrl: "https://mermaid.js.org/syntax/classDiagram.html",
    label: "Class v2",
    templateId: "class-v2-basic",
    templateSource:
      "classDiagram-v2\n  class Document {\n    +title\n    +diagramSource\n  }\n  Document --> MermaidDiagram",
  },
] as const satisfies ReadonlyArray<MermaidProductDiagramSpec>;

/*
 * Product templates are inventory, not readiness projections. Runtime and host
 * consumers derive their behavior from the registered family and GFX target.
 */
export const MERMAID_PRODUCT_TEMPLATES = MERMAID_PRODUCT_DIAGRAM_SPECS.map(
  ({ diagramType, label, templateId: id, templateSource: source }) => ({
    diagramType,
    id,
    label,
    source,
  }),
);

export function isMermaidProductDiagramType(
  diagramType: MermaidDiagramType,
): diagramType is MermaidProductDiagramType {
  return MERMAID_PRODUCT_DIAGRAM_TYPES.includes(
    diagramType as MermaidProductDiagramType,
  );
}
