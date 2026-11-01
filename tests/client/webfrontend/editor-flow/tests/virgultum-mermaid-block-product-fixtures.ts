// SPDX-License-Identifier: AGPL-3.0-or-later

export type MermaidBrowserGfxFixture = {
  readonly diagramType: string;
  readonly minEdges: number;
  readonly minNodes: number;
  readonly minSubgraphs?: number;
  readonly source: string;
};

export type MermaidBrowserSourceFirstFixture = {
  readonly diagramType: string;
  readonly label: string;
  readonly source: string;
};

// Flowchart has dedicated interaction-heavy browser smokes. Keep these types in
// the browser matrix so the static product-status gate can account for them.
export const MERMAID_BROWSER_FLOWCHART_GFX_TYPES = [
  "flowchart",
  "flowchart-elk",
] as const;

export const MERMAID_PAGE_VIEWPORT_FLOWCHART_FIXTURE = {
  diagramType: "flowchart",
  minEdges: 15,
  minNodes: 16,
  source: [
    "flowchart LR",
    "  Start[Start] --> A1[Review] --> B1[Retry] --> Done1[Done]",
    "  Start --> A2[Validate] --> B2[Revise] --> Done2[Accepted]",
    "  Start --> A3[Plan] --> B3[Build] --> Done3[Shipped]",
    "  Start --> A4[Observe] --> B4[Learn] --> Done4[Improved]",
    "  Start --> A5[Draft] --> B5[Approve] --> Done5[Published]",
  ].join("\n"),
} as const satisfies MermaidBrowserGfxFixture;

/** Pinned ER subgraph syntax exercises source scope and effective membership. */
export const MERMAID_ER_SUBGRAPH_FIXTURE = {
  diagramType: "erDiagram",
  minNodes: 3,
  minEdges: 2,
  minSubgraphs: 2,
  source: [
    "erDiagram",
    "direction LR",
    'subgraph Commerce ["Commerce domain"]',
    "  direction TB",
    '  subgraph Billing ["Billing records"]',
    "    direction RL",
    "    INVOICE { uuid id PK }",
    "    LINE_ITEM { uuid invoice_id PK, FK }",
    "    INVOICE ||--|{ LINE_ITEM : contains",
    "  end",
    "  CUSTOMER { uuid id PK }",
    "end",
    "CUSTOMER ||..o{ INVOICE : receives",
    "classDef aggregate stroke-width:2px",
    "class Commerce aggregate",
  ].join("\n"),
} as const satisfies MermaidBrowserGfxFixture;

export const MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES = [
  {
    diagramType: "sequenceDiagram",
    minEdges: 2,
    minNodes: 2,
    source: [
      "sequenceDiagram",
      "  participant User",
      "  participant Myoxus",
      "  User->>Myoxus: Request",
      "  Myoxus-->>User: Response",
    ].join("\n"),
  },
  {
    diagramType: "classDiagram",
    minEdges: 1,
    minNodes: 2,
    source: [
      "classDiagram",
      "  class Document {",
      "    +title",
      "    +diagramSource",
      "  }",
      "  Document --> MermaidDiagram",
    ].join("\n"),
  },
  {
    diagramType: "classDiagram-v2",
    minEdges: 1,
    minNodes: 2,
    source:
      "classDiagram-v2\n  class Legacy\n  class Modern\n  Legacy --> Modern",
  },
  {
    diagramType: "erDiagram",
    minEdges: 1,
    minNodes: 2,
    source: [
      "erDiagram",
      "  CUSTOMER {",
      "    string id",
      "    string name",
      "  }",
      "  ORDER {",
      "    string id",
      "  }",
      "  CUSTOMER ||--o{ ORDER : places",
    ].join("\n"),
  },
  {
    diagramType: "stateDiagram-v2",
    minEdges: 3,
    minNodes: 3,
    source:
      "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Active\n  Active --> [*]",
  },
  {
    diagramType: "stateDiagram",
    minEdges: 2,
    minNodes: 3,
    source: "stateDiagram\n  [*] --> Idle\n  Idle --> Done",
  },
  {
    diagramType: "gantt",
    minEdges: 0,
    minNodes: 2,
    minSubgraphs: 1,
    source: [
      "gantt",
      "  title Build Plan",
      "  dateFormat YYYY-MM-DD",
      "  section Work",
      "  Design :a1, 2026-01-01, 3d",
      "  Build :b1, 2026-01-05, 5d",
    ].join("\n"),
  },
  {
    diagramType: "journey",
    minEdges: 0,
    minNodes: 2,
    minSubgraphs: 2,
    source: [
      "journey",
      "  title Onboarding",
      "  section Discover",
      "    Read docs: 4: User",
      "  section Adopt",
      "    Publish: 3: Admin",
    ].join("\n"),
  },
  {
    diagramType: "timeline",
    minEdges: 0,
    minNodes: 3,
    minSubgraphs: 1,
    source: [
      "timeline",
      "  title Releases",
      "  section Web",
      "    2026 : Mermaid canvas : Export",
    ].join("\n"),
  },
  {
    diagramType: "mindmap",
    minEdges: 2,
    minNodes: 3,
    source: [
      "mindmap",
      "  root((Product))",
      "    Discovery",
      "      [Interview]",
    ].join("\n"),
  },
  {
    diagramType: "architecture",
    minEdges: 0,
    minNodes: 2,
    minSubgraphs: 1,
    source: [
      "architecture-beta",
      "  group api(cloud)[API]",
      "  service web(server)[Web] in api",
      "  service db(database)[Database] in api",
    ].join("\n"),
  },
  {
    diagramType: "block",
    minEdges: 0,
    minNodes: 2,
    source: ["block-beta", "  columns 2", "  A[Start]", "  B[Done]"].join("\n"),
  },
  {
    diagramType: "c4",
    minEdges: 1,
    minNodes: 2,
    source: [
      "C4Context",
      '  Person(user, "User", "Uses docs")',
      '  System(app, "Myoxus", "Workspace", "Rust")',
      '  Rel(user, app, "Uses", "HTTPS")',
    ].join("\n"),
  },
  {
    diagramType: "gitGraph",
    minEdges: 0,
    minNodes: 2,
    source: [
      "gitGraph",
      '  commit id:"A"',
      "  branch feature",
      "  checkout feature",
      '  commit id:"B"',
    ].join("\n"),
  },
  {
    diagramType: "requirementDiagram",
    minEdges: 0,
    minNodes: 2,
    source: [
      "requirementDiagram",
      "  requirement req1 {",
      "    id: 1",
      "    text: Must publish diagrams",
      "    risk: high",
      "    verifymethod: test",
      "  }",
      "  element ui {",
      "    type: userInterface",
      "    docref: web",
      "  }",
    ].join("\n"),
  },
] as const satisfies ReadonlyArray<MermaidBrowserGfxFixture>;

export const MERMAID_BROWSER_QUANTITATIVE_GFX_FIXTURES = [
  {
    diagramType: "quadrantChart",
    minEdges: 0,
    minNodes: 1,
    source: [
      "quadrantChart",
      "  title Priority",
      "  x-axis Low --> High",
      "  y-axis Cheap --> Expensive",
      "  Alpha: [0.25, 0.75]",
    ].join("\n"),
  },
  {
    diagramType: "pie",
    minEdges: 0,
    minNodes: 2,
    source: [
      "pie",
      "  title Work",
      "  showData",
      '  "Done" : 4',
      '  "Open" : 2',
    ].join("\n"),
  },
  {
    diagramType: "radar",
    minEdges: 0,
    minNodes: 3,
    source: [
      "radar-beta",
      "  axis Speed, Quality",
      "  curve Current {3,4}",
    ].join("\n"),
  },
  {
    diagramType: "packet",
    minEdges: 0,
    minNodes: 1,
    source: 'packet\n  0-3: "Version"',
  },
  {
    diagramType: "xychart",
    minEdges: 3,
    minNodes: 8,
    minSubgraphs: 1,
    source: [
      "xychart-beta",
      '  title "Sales"',
      "  x-axis [Jan, Feb]",
      '  y-axis "Revenue" 0 --> 10',
      "  bar Actual [1, 4]",
      "  line Target [2, 6]",
    ].join("\n"),
  },
  {
    diagramType: "sankey",
    minEdges: 2,
    minNodes: 3,
    source: ["sankey", "  Source, Process, 3", "  Process, Done, 1"].join("\n"),
  },
  {
    diagramType: "treemap",
    minEdges: 0,
    minNodes: 3,
    minSubgraphs: 1,
    source: ["treemap-beta", '"Root"', '  "A": 3', '  "B": 1'].join("\n"),
  },
] as const satisfies ReadonlyArray<MermaidBrowserGfxFixture>;

export const MERMAID_BROWSER_GFX_VISUAL_FIXTURES = [
  ...MERMAID_BROWSER_NON_FLOWCHART_GFX_FIXTURES,
  ...MERMAID_BROWSER_QUANTITATIVE_GFX_FIXTURES,
] as const satisfies ReadonlyArray<MermaidBrowserGfxFixture>;

export const MERMAID_BROWSER_SOURCE_FIRST_FIXTURES =
  [] as const satisfies ReadonlyArray<MermaidBrowserSourceFirstFixture>;
/**
 * One connected Gantt fixture for the Phase 11 journey: two sections, equal and
 * long labels, explicit id, date+end, decimal duration, previous, after, until,
 * several dependencies, status, milestone, `vert`, excludes and a comment.
 */
export const MERMAID_GANTT_JOURNEY_FIXTURE = {
  diagramType: "gantt",
  source: [
    "gantt",
    "  title Release Plan",
    "  dateFormat YYYY-MM-DD",
    "  excludes weekends",
    "  accTitle: Release timeline",
    "  section Discovery",
    "  %% kickoff note",
    "  Requirements : req1, 2026-09-01, 2026-09-04",
    "  Design : des1, 2026-09-04, 2.5d",
    "  Prototype : pr1, milestone, after des1, 0d",
    "  section Delivery",
    "  Implementation : imp1, after des1, 6d",
    "  Integration : int1, after imp1, 3d",
    "  Security review : sec1, 2026-09-21, 2026-09-25",
    "  Documentation : doc1, after sec1, 4d",
    "  Release marker : rel1, vert, 2026-09-30, 0d",
  ].join("\n"),
} as const;

// Dense publication machine: native v2 scopes, nested regions and retained annotations.
export const MERMAID_STATE_JOURNEY_FIXTURE =
  '---\ntitle: "Publication workflow"\nconfig:\n  state:\n    defaultRenderer: elk\n    nodeSpacing: 64\n    rankSpacing: 72\n---\nstateDiagram-v2\naccTitle: Publication workflow state machine\naccDescr {\n  A publication request is validated, rendered and either published or rejected.\n}\nhide empty description\nscale 1400 width\ndirection LR\n%% Diagram-level publication comment\nclassDef active fill:#e7f0ff,stroke:#315ea8,color:#172033\nclassDef warning fill:#fff1e8,stroke:#b65f28,color:#172033\nstate "Request draft" as Draft\nDraft: Collect publication request and requested output options\nDraft: Retain archived attachments and document metadata\nstate "Release processing" as Release {\n  direction TB\n  state "Validation pipeline" as Validation {\n    direction LR\n    [*] --> Schema\n    state Schema\n    Schema: Validate schema and output options\n    %% This comment belongs to the schema validation state.\n    Schema --> Policy: schema valid\n    state Policy\n    Policy: Verify permissions and publication policy\n    Policy --> [*]: accepted\n  }\n  Validation --> Decision: validation complete\n  state Decision <<choice>>\n  Decision --> Queue: accepted\n  Decision --> Rejected: invalid\n  state "Validation rejected" as Rejected\n  Rejected: Display actionable validation details\n  note right of Rejected: Reviewer can correct the request\n  --\n  [*] --> Waiting\n  state Waiting\n  Waiting: Await worker capacity\n  Waiting --> Running: worker available\n  state Running\n  Running: Render document and embedded assets\n  state Split <<fork>>\n  state Join <<join>>\n  Running --> Split: dispatch\n  Split --> Store: persist artifact\n  Split --> Audit: append audit event\n  state Store\n  Store: Store rendered publication\n  state Audit\n  Audit: Record immutable audit metadata\n  Store --> Join\n  Audit --> Join\n  Join --> [*]: complete\n}\nstate "Published release" as Published\nPublished: Visible to authorized readers\n[*] --> Draft: create\nDraft:::active --> Release:::active: submit\nRelease --> Published: checks passed\nPublished --> [*]: archive\nnote left of Published\n  The public link remains stable after republishing.\nend note\nnote "Rollback remains available" as RollbackNote\nclass Published active\nclass Rejected warning\nstyle Decision fill:#fff8e8,stroke:#a66b1f\nclick Published href "https://example.invalid/releases" "Open release record"\n%% This comment belongs after the publish link.';

/** Dense Block reference: nested local grids, zero Space, parallel/self relations and three local comments. */
export const MERMAID_BLOCK_JOURNEY_FIXTURE =
  '---\ntitle: "Publication pipeline"\nconfig:\n  block:\n    padding: 12\n---\nblock-beta\n  columns 4\n\n  %% Intake remains visually separate from the processing composite.\n  input(["Request input"]):1\n  space\n  block:process["Processing"]:2\n    columns 2\n    %% Validate before transformation.\n    validate{"Validate"}:1\n    transform[["Transform document"]]:1\n    space:1\n    block:store["Storage"]:1\n      columns 1\n      object[("Object store")]\n      audit((("Audit log")))\n    end\n  end\n\n  publish(["Publish"]):1\n  reject>"Reject"]:1\n  archive[("Archive")]:1\n  dispatch<["Dispatch"]>(right, down):1\n\n  %% Request relation stays attached.\n  input -- "request" --> validate\n  validate -- "valid" --> transform\n  validate -. "invalid" .-> reject\n  transform == "ready" ==> publish\n  publish o-- "retained" --x archive\n  input ~~~ publish\n  input -- "priority" --> validate\n  publish -- "retry" --> publish\n  space:0\n\n  classDef active fill:#dbeafe,stroke:#2563eb,color:#172554\n  class validate,transform active\n  style publish fill:#dcfce7,stroke:#16a34a,color:#052e16\n';
