import {
  MERMAID_11_DIAGRAM_FIXTURES,
  MermaidBlockComponent,
  describe,
  expect,
  getMermaidBlockTitle,
  hashMermaidSource,
  installProjectedMermaidTestTheme,
  isMermaidChartFacadeType,
  isMermaidGraphGfxDiagramType,
  parseMermaidSourceToGfxVisualModel,
  renderBlockForSource,
  renderVisualEditorForSource,
  test,
} from "./mermaid-test-support.js";
import { afterEach, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Mermaid block host contracts", () => {
  test("renders visual mode as the default editing surface without the source textarea", () => {
    const host = renderBlockForSource({
      source: "flowchart TD\n  A[Start] --> B[Result]\n",
    });

    expect(host.querySelector("[data-display-mode='edit']")).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector("[data-mermaid-display-mode='edit']"),
    ).toBeTruthy();
    expect(
      host.querySelector("[data-mermaid-gfx-editable='true']"),
    ).toBeTruthy();
    expect(
      host.querySelector("[data-mermaid-gfx-surface='true']"),
    ).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(
      host.querySelector('[data-myoxus-ui-role="toolbar-surface"]'),
    ).toBeTruthy();
    expect(
      host.querySelector(
        '[data-myoxus-ui-role="mermaid-editor-workarea-owner"]',
      ),
    ).toBeTruthy();
    expect(host.querySelector("[aria-label='Add node']")).toBeTruthy();
    expect(
      host.querySelector("[data-myoxus-mermaid-shape-palette='true']"),
    ).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-source")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-preview")).toBeFalsy();
    expect(
      host.querySelector(".myoxus-mermaid-viewport-resize-handle"),
    ).toBeTruthy();
    expect(host.textContent).toContain("Visual");
    expect(host.textContent).toContain("Source");
    expect(host.textContent).toContain("View");
  });

  test("renders view mode inside the shared shell as a read-only GFX surface", () => {
    const host = renderBlockForSource({
      displayMode: "display",
      source: "flowchart TD\n  A[Start] --> B[Result]\n",
    });

    expect(host.querySelector(".myoxus-mermaid-display-card")).toBeFalsy();
    expect(host.querySelector("[data-display-mode='display']")).toBeTruthy();
    expect(
      host.querySelector('[data-myoxus-ui-role="mermaid-editor-shell-header"]'),
    ).toBeTruthy();
    expect(
      host.querySelector('[data-myoxus-ui-role="mermaid-editor-mode-control"]'),
    ).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-display-preview")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector("[data-mermaid-display-mode='display']"),
    ).toBeTruthy();
    expect(
      host.querySelector("[data-mermaid-gfx-editable='false']"),
    ).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-visual-toolbar")).toBeFalsy();
    expect(
      host.querySelector(".myoxus-mermaid-viewport-resize-handle"),
    ).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-source")).toBeFalsy();
    expect(host.textContent).toContain("View");
    expect(host.textContent).toContain("Visual");
    expect(host.textContent).toContain("Source");
  });

  test("renders Architecture display mode through the display-only GFX path", () => {
    installProjectedMermaidTestTheme();
    const host = renderBlockForSource({
      displayMode: "display",
      source:
        "architecture-beta\n  group web(cloud)[Web]\n  service app(server)[App] in web\n",
    });

    expect(
      host.querySelector('[data-myoxus-ui-role="mermaid-editor-shell-header"]'),
    ).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-display-preview")).toBeFalsy();
    expect(
      host.querySelector(
        ".myoxus-mermaid-gfx-editor[data-diagram-type='architecture'][data-mermaid-display-mode='display'][data-mermaid-gfx-editable='false']",
      ),
    ).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-visual-toolbar")).toBeFalsy();
    expect(
      host.querySelector(".myoxus-mermaid-viewport-resize-handle"),
    ).toBeFalsy();
  });

  test.each(["display", "edit"] as const)(
    "projects readonly %s content through the shared view surface",
    (displayMode) => {
      const host = renderBlockForSource({
        displayMode,
        readonly: true,
        source: "flowchart TD\n  A[Start] --> B[Result]\n",
      });

      expect(host.querySelector(".myoxus-mermaid-display-card")).toBeFalsy();
      expect(
        host.querySelector(
          '[data-myoxus-ui-role="mermaid-editor-shell-header"]',
        ),
      ).toBeTruthy();
      expect(
        host.querySelector("[data-mermaid-display-mode='display']"),
      ).toBeTruthy();
      expect(host.querySelector(".myoxus-mermaid-display-preview")).toBeFalsy();
      expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
      expect(
        host.querySelector("[data-mermaid-gfx-editable='false']"),
      ).toBeTruthy();
      expect(host.querySelector(".myoxus-mermaid-visual-toolbar")).toBeNull();
      expect(host.querySelector(".myoxus-mermaid-source")).toBeNull();
    },
  );

  test("renders Flowchart source mode without a parallel non-GFX preview", () => {
    const host = renderBlockForSource({
      mode: "source",
      source: "flowchart TD\n  A[Start] --> B[Result]\n",
    });

    expect(host.querySelector(".myoxus-mermaid-source")).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-preview")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
  });

  test("requests a host update when source edits auto-update the Mermaid title", () => {
    const mutableText = (initial: string) => {
      let value = initial;
      return {
        get length() {
          return value.length;
        },
        delete: () => {
          value = "";
        },
        insert: (next: string) => {
          value = next;
        },
        toString: () => value,
      };
    };
    const calls: string[] = [];
    const component = {
      _acceptProjectionOwnerSourceSyncKey: () => calls.push("accept"),
      _cancelPageSelectionMode: () => undefined,
      _clearPendingVisualSelectionProjection: () => undefined,
      _clearVisualSelectionState: () => calls.push("clear-selection"),
      _ensureProjectionOwner: () => calls.push("ensure-owner"),
      _getScopedGfxController: () => null,
      _pauseProjectionOwnerSourceSync: () => calls.push("pause-sync"),
      model: {
        id: "mermaid",
        props: {
          diagramType: "flowchart",
          source: mutableText("flowchart TD\n  A --> B"),
          sourceHash: hashMermaidSource("flowchart TD\n  A --> B"),
          title: mutableText("Flowchart"),
        },
        store: {
          getParent: () => null,
        },
      },
      requestUpdate: () => calls.push("request-update"),
    } as unknown as MermaidBlockComponent;

    (
      MermaidBlockComponent.prototype as unknown as {
        _writeMermaidSource: (value: string) => void;
      }
    )._writeMermaidSource.call(
      component,
      "sequenceDiagram\n  participant User",
    );

    expect(getMermaidBlockTitle(component.model.props)).toBe("Sequence");
    expect(component.model.props.diagramType).toBe("sequenceDiagram");
    expect(calls).toEqual([
      "pause-sync",
      "ensure-owner",
      "accept",
      "request-update",
    ]);
  });

  test("renders ER diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const host = renderVisualEditorForSource(
      "erDiagram\n  CUSTOMER {\n    string id PK\n  }\n  ORDER {\n    string id PK\n  }\n  CUSTOMER ||--o{ ORDER : places\n",
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("erDiagram");
    expect(host.querySelector(".myoxus-mermaid-er-entity")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-er-relationship")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders C4 diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const source =
      'C4Context\n  title Context\n  Person(user, "User", "Uses docs")\n  System(app, "Myoxus", "Workspace", "Rust")\n  Rel(user, app, "Uses", "HTTPS")\n';
    const host = renderVisualEditorForSource(source);
    const visualModel = parseMermaidSourceToGfxVisualModel(source).model!;

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("c4");
    expect(host.querySelector(".myoxus-mermaid-c4-element")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-c4-relationship")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(visualModel.nodes[1]).toMatchObject({
      displayLabel: "Myoxus\n[Software System]\nWorkspace",
      label: "Myoxus",
    });
    expect(visualModel.edges[0]).toMatchObject({
      familyData: {
        family: "c4",
        payload: { relationshipKind: "Rel", technology: "HTTPS" },
      },
      label: "Uses",
    });
  });

  test("renders architecture diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    installProjectedMermaidTestTheme();
    const source =
      'architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[Database] in api\n  web:R -["reads"]-> L:db\n';
    const host = renderVisualEditorForSource(source);
    const visualModel = parseMermaidSourceToGfxVisualModel(source).model!;

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("architecture");
    expect(
      host.querySelector(".myoxus-mermaid-architecture-service"),
    ).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-architecture-edge")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(visualModel.subgraphs?.[0]).toMatchObject({
      nodeIds: ["web", "db"],
    });
    expect(visualModel.subgraphs?.[0]?.title).toContain("API");
    expect(visualModel.nodes[1]).toMatchObject({
      displayLabel: expect.stringContaining("Database"),
      label: "Database",
      textVerticalAlign: "bottom",
    });
    expect(visualModel.edges[0]).toMatchObject({
      label: "reads",
      sourcePosition: [1, 0.5],
      targetPosition: [0, 0.5],
    });
  });

  test("renders block diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const host = renderVisualEditorForSource(
      'block-beta\n  columns 2\n  A["Start"]\n  B["Done"]\n  A -- "next" --> B\n',
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("block");
    expect(host.querySelector(".myoxus-mermaid-block-node")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-block-edge")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders class diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const host = renderVisualEditorForSource(
      "classDiagram\n  class Document {\n    +title\n  }\n  Document --> MermaidDiagram : renders\n",
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("classDiagram");
    expect(host.querySelector(".myoxus-mermaid-class-node")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-class-relation")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders sequence diagrams through the shared owner GFX editor", () => {
    const host = renderVisualEditorForSource(
      "sequenceDiagram\n  participant Alice\n  actor Bob\n  Alice->>Bob: Hello\n  Bob-->>Alice: Done\n",
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("sequenceDiagram");
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(
      host.querySelector(".myoxus-mermaid-sequence-participant"),
    ).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-sequence-message")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders state diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const host = renderVisualEditorForSource(
      'stateDiagram-v2\n  [*] --> A\n  state "Review" as A\n  A --> B : approve\n  B --> [*]\n',
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("stateDiagram-v2");
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-node")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-edge")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders gantt diagrams through the Core Temporal Facade host", () => {
    const host = renderVisualEditorForSource(
      "gantt\n  title Release\n  dateFormat YYYY-MM-DD\n  section Build\n  Design :done, design, 2026-01-01, 2d\n  Ship :active, ship, after design, 1d\n",
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-temporal-editor")
        ?.dataset.diagramType,
    ).toBe("gantt");
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-gantt-section")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-gantt-task")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-gantt-dependency")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders gitGraph diagrams through the shared owner GFX editor", () => {
    const host = renderVisualEditorForSource(
      'gitGraph\n  commit id:"A"\n  branch feature\n  checkout feature\n  commit id:"B"\n  checkout main\n  merge feature\n',
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("gitGraph");
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-git-branch")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-git-commit")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-git-operation")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders mindmap diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const host = renderVisualEditorForSource(
      "mindmap\n  root((Product))\n    Discovery\n      [Interview]\n    Delivery\n",
    );

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("mindmap");
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-mindmap-node")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-mindmap-branch")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    const visualModel = parseMermaidSourceToGfxVisualModel(
      "mindmap\n  root((Product))\n    Discovery\n      [Interview]\n    Delivery\n",
    ).model!;
    expect(visualModel.nodes.map((node) => node.label)).toEqual([
      "Product",
      "Discovery",
      "Interview",
      "Delivery",
    ]);
    expect(visualModel.edges.map((edge) => [edge.source, edge.target])).toEqual(
      [
        [visualModel.nodes[0].id, visualModel.nodes[1].id],
        [visualModel.nodes[1].id, visualModel.nodes[2].id],
        [visualModel.nodes[0].id, visualModel.nodes[3].id],
      ],
    );
  });

  test("renders requirement diagrams through the shared owner GFX editor instead of a type-local canvas", () => {
    const source =
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Must publish diagrams\n    risk: high\n    verifymethod: test\n  }\n  element ui {\n    type: userInterface\n    docref: web\n  }\n  req1 - satisfies -> ui\n";
    const host = renderVisualEditorForSource(source);
    const visualModel = parseMermaidSourceToGfxVisualModel(source).model!;

    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeTruthy();
    expect(
      host.querySelector<HTMLElement>(".myoxus-mermaid-gfx-editor")?.dataset
        .diagramType,
    ).toBe("requirementDiagram");
    expect(host.querySelector(".myoxus-mermaid-requirement-card")).toBeFalsy();
    expect(
      host.querySelector(".myoxus-mermaid-requirement-relation"),
    ).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-visual-canvas")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(visualModel.nodes[0]).toMatchObject({
      details: expect.arrayContaining([
        expect.objectContaining({
          label: "risk",
          value: "high",
        }),
        expect.objectContaining({
          label: "verify",
          value: "test",
        }),
        expect.objectContaining({
          label: "text",
          value: "Must publish diagrams",
        }),
      ]),
      displayLabel: "req1",
      label: "req1",
      shape: "doc",
    });
    expect(visualModel.edges[0]).toMatchObject({
      familyData: {
        family: "requirement",
        payload: { relationKind: "satisfies" },
      },
      source: "req1",
      target: "ui",
    });
  });

  test("renders pie charts through the Core Chart Facade host", () => {
    const host = renderVisualEditorForSource(
      'pie showData\n  title Work\n  "Done" : 4\n  "Open" : 2\n',
    );

    const editor = host.querySelector<HTMLElement>(
      '[data-testid="mermaid-pie-view"]',
    );
    expect(editor).toBeTruthy();
    expect(editor?.dataset.diagramType).toBe("pie");
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-pie-slice")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders sankey diagrams through the Core Chart Facade host", () => {
    const host = renderVisualEditorForSource(
      "sankey\n  Source, Target, 3\n  Source, Archive, 1\n",
    );

    const editor = host.querySelector<HTMLElement>(
      '[data-testid="mermaid-sankey-view"]',
    );
    expect(editor).toBeTruthy();
    expect(editor?.dataset.diagramType).toBe("sankey");
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-sankey-node")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-sankey-link")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("renders timeline diagrams through the Core Temporal Facade host", () => {
    const host = renderVisualEditorForSource(
      "timeline\n  title Releases\n  section Web\n    2026 : Mermaid canvas : Export\n",
    );

    const editor = host.querySelector<HTMLElement>(
      ".myoxus-mermaid-temporal-editor",
    );
    expect(editor).toBeTruthy();
    expect(editor?.dataset.diagramType).toBe("timeline");
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-timeline-period")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-timeline-event")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(host.textContent).not.toContain("Source-first diagram");
  });

  test("renders treemap diagrams through the Core Chart Facade host", () => {
    const host = renderVisualEditorForSource(
      'treemap-beta\n"Root"\n  "A": 3\n  "B": 1\n',
    );

    const editor = host.querySelector<HTMLElement>(
      ".myoxus-mermaid-chart-editor",
    );
    expect(editor).toBeTruthy();
    expect(editor?.dataset.diagramType).toBe("treemap");
    expect(host.querySelector(".myoxus-mermaid-gfx-editor")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-treemap-node")).toBeFalsy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
  });

  test("keeps Architecture controls readonly while preserving the complete visual structure", () => {
    installProjectedMermaidTestTheme();
    const fixture = MERMAID_11_DIAGRAM_FIXTURES.find(
      ({ diagramType }) => diagramType === "architecture",
    )!;
    const host = renderVisualEditorForSource(fixture.source, true);
    const visualEditor = host.querySelector(
      '.myoxus-mermaid-gfx-editor[data-diagram-type="architecture"]',
    );
    const controls = [
      ...host.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
        ".myoxus-mermaid-visual-toolbar button, .myoxus-mermaid-visual-toolbar input",
      ),
    ];

    expect(visualEditor).toBeTruthy();
    expect(controls.length).toBeGreaterThan(0);
    expect(controls.every((control) => control.disabled)).toBe(true);
  });

  test("keeps the remaining product visual editor controls readonly when the store is readonly", () => {
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) => diagramType !== "architecture",
    )) {
      const host = renderVisualEditorForSource(fixture.source, true);
      const controls = [
        ...host.querySelectorAll<
          HTMLButtonElement | HTMLInputElement | HTMLSelectElement
        >(
          ".myoxus-mermaid-visual-toolbar button, .myoxus-mermaid-visual-toolbar input, .myoxus-mermaid-visual-toolbar select",
        ),
      ];
      const visualEditor = host.querySelector(
        '.myoxus-mermaid-visual-canvas, .myoxus-mermaid-gfx-editor, .myoxus-mermaid-temporal-editor, .myoxus-mermaid-kanban-editor, .myoxus-mermaid-chart-editor, .myoxus-mermaid-journey-editor, .myoxus-mermaid-packet-editor, [data-testid="mermaid-pie-view"], [data-testid="mermaid-sankey-view"]',
      );
      const sourceOnly =
        fixture.diagramType !== "flowchart" &&
        fixture.diagramType !== "flowchart-elk" &&
        fixture.diagramType !== "kanban" &&
        fixture.diagramType !== "gantt" &&
        fixture.diagramType !== "timeline" &&
        fixture.diagramType !== "journey" &&
        fixture.diagramType !== "packet" &&
        !isMermaidChartFacadeType(fixture.diagramType) &&
        !isMermaidGraphGfxDiagramType(fixture.diagramType);

      if (sourceOnly) {
        expect(
          visualEditor,
          `${fixture.diagramType} must stay source-first until its shared editor path is implemented`,
        ).toBeFalsy();
        expect(
          controls.length,
          `${fixture.diagramType} should not expose Mermaid controls`,
        ).toBe(0);
        expect(
          host.querySelector(".myoxus-mermaid-structured-row"),
        ).toBeFalsy();
        continue;
      }

      expect(
        visualEditor,
        `${fixture.diagramType} must still render its visual canvas in readonly mode`,
      ).toBeTruthy();
      if (
        fixture.diagramType === "kanban" ||
        fixture.diagramType === "gantt" ||
        fixture.diagramType === "journey" ||
        fixture.diagramType === "packet" ||
        fixture.diagramType === "timeline" ||
        isMermaidChartFacadeType(fixture.diagramType)
      ) {
        expect(visualEditor?.getAttribute("data-readonly")).toBe("true");
        continue;
      }
      expect(
        controls.length,
        `${fixture.diagramType} should expose readonly visual controls`,
      ).toBeGreaterThan(0);
      expect(
        controls.every((control) => control.disabled),
        `${fixture.diagramType} must disable all visual controls in readonly mode`,
      ).toBe(true);
    }
  });

  test("keeps Mermaid source mode readonly when the store is readonly", () => {
    const host = renderBlockForSource({
      mode: "source",
      readonly: true,
      source: "flowchart TD\n  A[Start] --> B[Done]\n",
    });
    const source = host.querySelector<HTMLTextAreaElement>(
      ".myoxus-mermaid-source",
    );
    const chromeControls = [
      ...host.querySelectorAll<HTMLInputElement>(
        '[data-myoxus-ui-role="mermaid-shell-title"]',
      ),
    ];

    expect(source).toBeTruthy();
    expect(source?.disabled).toBe(true);
    expect(chromeControls.length).toBeGreaterThan(0);
    expect(chromeControls.every((control) => control.disabled)).toBe(true);
  });

  test("keeps valid Kanban metadata in the native readonly preview", () => {
    const host = renderBlockForSource({
      readonly: true,
      source:
        'kanban\n  todo[To Do]\n    ["Spec"]@{assigned: "QA", retained: "foreign"}\n',
    });
    expect(
      host.querySelector("[data-editor-surface='source-first']"),
    ).toBeNull();
    expect(host.querySelector(".myoxus-mermaid-source")).toBeNull();
    expect(host.querySelector(".myoxus-mermaid-kanban-editor")).toBeNull();
    expect(host.textContent).toContain("View");
    expect(host.textContent).toContain("Visual");
  });

  test("isolates visual toolbar editing events from block/editor shortcuts", () => {
    const host = renderVisualEditorForSource(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    document.body.append(host);
    const toolbar = host.querySelector(".myoxus-mermaid-visual-toolbar")!;
    const control = toolbar.querySelector<HTMLElement>("button")!;
    const events: string[] = [];
    host.addEventListener("beforeinput", () => events.push("beforeinput"));
    host.addEventListener("click", () => events.push("click"));
    host.addEventListener("keydown", () => events.push("keydown"));
    host.addEventListener("keypress", () => events.push("keypress"));
    host.addEventListener("keyup", () => events.push("keyup"));
    host.addEventListener("input", () => events.push("input"));
    host.addEventListener("mousedown", () => events.push("mousedown"));
    host.addEventListener("mouseup", () => events.push("mouseup"));
    host.addEventListener("pointerdown", () => events.push("pointerdown"));

    control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    control.dispatchEvent(new InputEvent("beforeinput", { bubbles: true }));
    control.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "a" }),
    );
    control.dispatchEvent(
      new KeyboardEvent("keypress", { bubbles: true, key: "a" }),
    );
    control.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "a" }),
    );
    control.dispatchEvent(new InputEvent("input", { bubbles: true }));
    control.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    control.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));

    expect(events).toEqual([]);
    host.remove();
  });
});
