import {
  DEFAULT_MERMAID_FONT_FAMILY,
  MERMAID_11_DIAGRAM_FIXTURES,
  getMermaidEdgelessToolbarTemplates,
  MERMAID_PRODUCT_DIAGRAM_SPECS,
  MERMAID_PRODUCT_DIAGRAM_TYPES,
  MERMAID_PRODUCT_TEMPLATES,
  MermaidBlockSchema,
  canShowMermaidSlashItem,
  createMermaidBlockInsertProps,
  createMermaidBlockSnapshot,
  createSlashContext,
  describe,
  detectMermaidDiagramType,
  effects,
  expect,
  expectMermaidVisualHash,
  expectPresent,
  getMermaidBlockSource,
  getMermaidBlockTitle,
  hashMermaidSource,
  installProjectedMermaidTestTheme,
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  insertMermaidEdgelessToolbarTemplate,
  internalPrimitives,
  isMermaidChartFacadeType,
  isMermaidFamilyVisualEditingDiagramType,
  isMermaidGraphGfxDiagramType,
  isMermaidProductDiagramType,
  mermaidBlockMarkdownAdapterMatcher,
  mermaidMessages,
  mermaidSlashMenuConfig,
  normalizeMermaidSourceInput,
  parseMermaidSourceToGfxVisualModel,
  parseMermaidSourceToVisualModel,
  renderBlockForSource,
  renderVisualEditorForSource,
  resolveMermaidFamilyRuntime,
  setMermaidBlockText,
  setMermaidI18nTranslator,
  test,
  type SlashMenuContext,
} from "./mermaid-test-support.js";
import { resolveMermaidBlockInsertIdentity } from "../mermaid-insert-identity.js";
import { createMermaidClipboardPayloadV2 } from "../clipboard.js";
import * as Y from "yjs";

describe("Mermaid product integration contracts", () => {
  test("retains persisted Timeline source bytes across structured clipboard and insertion", () => {
    const source =
      "timeline TD\r\n  P : A : B  \r\n  %% retained\r\n    : C\r\n";
    const payload = createMermaidClipboardPayloadV2({
      id: "clipboard-owner",
      props: { source, title: "", comments: {} },
    } as never);
    expect(payload?.source).toBe(source);
    const inserted = createMermaidBlockInsertProps({
      source: payload!.source,
      title: payload!.title,
      preserveSourceBytes: true,
    });
    const doc = new Y.Doc();
    try {
      doc.getMap("block").set("source", inserted.source.yText);
      expect(getMermaidBlockSource(inserted)).toBe(source);
      expect(inserted.sourceHash).toBe(hashMermaidSource(source));
    } finally {
      doc.destroy();
    }
  });
  test("routes Mermaid chrome through the injected central i18n bridge when configured", () => {
    setMermaidI18nTranslator((key, options) => {
      if (key.endsWith(".export-label")) {
        return `${key}:${options?.title}`;
      }
      return key;
    });

    expect(mermaidMessages.modeSource()).toBe(
      "com.myoxus.editor.mermaid.mode-source",
    );
    expect(mermaidMessages.exportLabel("Flow")).toBe(
      "com.myoxus.editor.mermaid.export-label:Flow",
    );
    expect(mermaidMessages.visualShowAllShapes()).toBe(
      "com.myoxus.editor.mermaid.visual-show-all-shapes",
    );

    expect(mermaidMessages.visualRetry()).toBe("Retry");

    setMermaidI18nTranslator(null);
    expect(mermaidMessages.visualRetry()).toBe("Retry");
    expect(mermaidMessages.modeSource()).toBe("Source");
    expect(mermaidMessages.exportLabel("Flow")).toBe("Mermaid diagram: Flow");
    expect(mermaidMessages.visualShowAllShapes()).toBe("All shapes");
    expect(mermaidMessages.visualShowCoreShapes()).toBe("Core shapes");
    expect(mermaidMessages.selectedSequenceParticipantKind()).toBe(
      "Selected sequence participant kind",
    );
  });

  test("declares the canonical myoxus:mermaid model", () => {
    const props = MermaidBlockSchema.model.props(internalPrimitives);

    expect(MermaidBlockSchema.model.flavour).toBe("myoxus:mermaid");
    expect(props.source.length).toBe(0);
    expect(props.title.length).toBe(0);
    expect(props).not.toHaveProperty("reference");
    expect(props).not.toHaveProperty("managed");
    expect(props.diagramVersion).toBe(1);
    expect(props.displayMode).toBe("edit");
    expect(props.viewportHeight).toBeNull();
    expect(props).not.toHaveProperty("visualModel");
    expect(props).not.toHaveProperty("visualModelHash");
    expect(getMermaidBlockTitle(props)).toBe("Mermaid diagram");
    expect(hashMermaidSource("flowchart TD\nA-->B")).toMatch(/^fnv1a:/);
  });

  test("creates edit-mode Mermaid insert props with automatic viewport sizing", () => {
    const props = createMermaidBlockInsertProps({
      source: "flowchart TD\n  A --> B",
    });

    expect(props.displayMode).toBe("edit");
    expect(props.viewportHeight).toBeNull();
    expect(props.diagramType).toBe("flowchart");
    expect(props).not.toHaveProperty("visualModelHash");
    expect(props.source.length).toBeGreaterThan(
      "flowchart TD\n  A --> B".length,
    );
    expect(props.title.length).toBe("Flowchart".length);
  });

  test("uses Myoxus UI typography for Mermaid SVG rendering by default", () => {
    expect(DEFAULT_MERMAID_FONT_FAMILY).toContain(
      "--myoxus-typography-body-family",
    );
    expect(DEFAULT_MERMAID_FONT_FAMILY).not.toMatch(
      /mono|monospace|menlo|consolas/i,
    );
  });

  test("updates sourceHash whenever the first-class source changes", () => {
    let storedSource = "";
    const model = {
      props: {
        source: {
          length: 0,
          delete: () => {
            storedSource = "";
          },
          insert: (value: string) => {
            storedSource = value;
          },
        },
        sourceHash: "",
      },
    } as never;

    setMermaidBlockText(model, "source", "flowchart TD\nA-->B");

    expect(storedSource).toBe("flowchart TD\nA-->B");
    expect((model as { props: { sourceHash: string } }).props.sourceHash).toBe(
      hashMermaidSource("flowchart TD\nA-->B"),
    );
  });

  test("normalizes pasted and empty-state Markdown fences to canonical Mermaid source", () => {
    expect(
      normalizeMermaidSourceInput("```mermaid\nflowchart TD\n  A --> B\n```\n"),
    ).toBe("flowchart TD\n  A --> B");
    expect(
      normalizeMermaidSourceInput(
        "```mermaid\nsequenceDiagram\n  Alice->>Bob: Hi\n```\n",
      ),
    ).toBe("sequenceDiagram\n  Alice->>Bob: Hi");
    expect(normalizeMermaidSourceInput("flowchart LR\r\n  A --> B")).toBe(
      "flowchart LR\n  A --> B",
    );
  });

  test("detects every Mermaid 11.12 diagram family as first-class Mermaid", () => {
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES) {
      expect(detectMermaidDiagramType(fixture.source)).toBe(
        fixture.diagramType,
      );
      expect(parseMermaidSourceToVisualModel(fixture.source).diagramType).toBe(
        fixture.diagramType,
      );
    }
  });

  test("keeps Mermaid info out of product diagram coverage", () => {
    expect(detectMermaidDiagramType("info\nshowInfo\n")).toBe("unknown");
    expect(
      MERMAID_PRODUCT_TEMPLATES.some((template) =>
        template.id.includes("info"),
      ),
    ).toBe(false);
    expect(
      MERMAID_PRODUCT_DIAGRAM_TYPES.some(
        (diagramType) => diagramType === ("info" as never),
      ),
    ).toBe(false);
    expect(isMermaidProductDiagramType("unknown")).toBe(false);
    expect(isMermaidProductDiagramType("classDiagram-v2")).toBe(true);
    expect(isMermaidProductDiagramType("flowchart-elk")).toBe(true);
    expect(isMermaidProductDiagramType("stateDiagram")).toBe(true);
  });

  test("keeps product diagram specs, templates, docs and detector in sync", () => {
    expect(MERMAID_PRODUCT_DIAGRAM_TYPES).toHaveLength(25);
    expect(MERMAID_PRODUCT_DIAGRAM_SPECS).toHaveLength(
      MERMAID_PRODUCT_DIAGRAM_TYPES.length,
    );
    expect(MERMAID_PRODUCT_TEMPLATES).toHaveLength(
      MERMAID_PRODUCT_DIAGRAM_SPECS.length,
    );
    const templateIds = new Set<string>();
    const diagramTypes = new Set<string>();

    for (const spec of MERMAID_PRODUCT_DIAGRAM_SPECS) {
      expect(spec.docUrl).toMatch(/^https:\/\/mermaid\.js\.org\/syntax\//);
      expect(spec.templateId).not.toContain("info");
      expect(spec.templateSource).not.toMatch(/^info\b/m);
      expect(detectMermaidDiagramType(spec.templateSource)).toBe(
        spec.diagramType,
      );
      expect(isMermaidProductDiagramType(spec.diagramType)).toBe(true);
      expect(templateIds.has(spec.templateId)).toBe(false);
      expect(diagramTypes.has(spec.diagramType)).toBe(false);
      templateIds.add(spec.templateId);
      diagramTypes.add(spec.diagramType);
    }

    for (const diagramType of MERMAID_PRODUCT_DIAGRAM_TYPES) {
      expect(diagramTypes.has(diagramType)).toBe(true);
    }
  });

  test("keeps templates as neutral insertion inventory", () => {
    for (const template of MERMAID_PRODUCT_TEMPLATES) {
      expect(Object.keys(template).sort()).toEqual([
        "diagramType",
        "id",
        "label",
        "source",
      ]);
      expect(
        MERMAID_PRODUCT_DIAGRAM_SPECS.find(
          ({ diagramType }) => diagramType === template.diagramType,
        )?.templateSource,
      ).toBe(template.source);
    }
  });

  test("projects Architecture into its owned owner GFX visual model", () => {
    installProjectedMermaidTestTheme();
    const parsed = parseMermaidSourceToGfxVisualModel(
      'architecture-beta\n  group api(cloud)[API]\n  service web(server)[Web] in api\n  service db(database)[Database] in api\n  web:R -["reads"]- L:db\n',
    );

    expect(parsed.diagramType).toBe("architecture");
    expectPresent(parsed.model);
    expect(parsed.model.diagramType).toBe("architecture");
    expectMermaidVisualHash(parsed.visualModelHash);
    expect(parsed.model.nodes).toHaveLength(2);
    expect(parsed.model.edges).toHaveLength(1);
    expect([...new Set(parsed.model.nodes.map((node) => node.shape))]).toEqual(
      expect.arrayContaining(["subroutine"]),
    );
  });

  test("projects the remaining graph-like Mermaid product types into the shared owner GFX visual model", () => {
    const fixtures = [
      {
        expectedShapes: ["rect"],
        minEdges: 1,
        source:
          'block-beta\n  columns 2\n  A["Start"]\n  B["Done"]\n  A -- "next" --> B\n',
        type: "block",
      },
      {
        expectedShapes: ["rounded"],
        minEdges: 1,
        source:
          'C4Context\n  Person(user, "User", "Uses docs")\n  System(app, "Myoxus", "Workspace", "Rust")\n  Rel(user, app, "Uses", "HTTPS")\n',
        type: "c4",
      },
      {
        expectedShapes: ["rect"],
        minEdges: 1,
        source:
          "classDiagram\n  class User {\n    +id\n  }\n  class Order\n  User <|-- Order : owns\n",
        type: "classDiagram",
      },
      {
        expectedShapes: ["rect"],
        minEdges: 1,
        source:
          "erDiagram\n  CUSTOMER {\n    string name PK\n  }\n  ORDER {\n    string id PK\n  }\n  CUSTOMER ||--o{ ORDER : places\n",
        type: "erDiagram",
      },
      {
        expectedShapes: ["circle", "rounded", "rect"],
        minEdges: 2,
        source:
          "mindmap\n  root((Product))\n    Discovery\n      [Interview]\n",
        type: "mindmap",
      },
      {
        expectedShapes: ["doc", "rect"],
        minEdges: 1,
        source:
          "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Must publish diagrams\n  }\n  element ui {\n    type: userInterface\n  }\n  req1 - satisfies -> ui\n",
        type: "requirementDiagram",
      },
      {
        expectedShapes: ["circle", "doublecircle", "rounded"],
        minEdges: 1,
        source:
          'stateDiagram-v2\n  [*] --> Draft\n  state "In Review" as Review\n  Draft --> Review : submit\n  Review --> [*] : publish\n',
        type: "stateDiagram-v2",
      },
    ] as const;

    for (const fixture of fixtures) {
      const parsed = parseMermaidSourceToGfxVisualModel(fixture.source);
      expect(parsed.diagramType).toBe(fixture.type);
      expectPresent(parsed.model);
      expect(parsed.model.diagramType).toBe(fixture.type);
      expectMermaidVisualHash(parsed.visualModelHash);
      expect(parsed.model.nodes.length).toBeGreaterThanOrEqual(2);
      if ("minEdges" in fixture) {
        expect(parsed.model.edges.length).toBeGreaterThanOrEqual(
          fixture.minEdges,
        );
      }
      expect([
        ...new Set(parsed.model.nodes.map((node) => node.shape)),
      ]).toEqual(expect.arrayContaining([...fixture.expectedShapes]));
    }
  });

  test("keeps unsupported diagrams source-first while Kanban uses Core Facade", () => {
    const unsupported = "info\n  showInfo\n";
    expect(resolveMermaidFamilyRuntime(unsupported)).toMatchObject({
      kind: "source-first",
      source: unsupported,
    });
    expect(
      resolveMermaidFamilyRuntime("kanban\n  todo[To Do]\n    t1[Task]\n"),
    ).toMatchObject({ capabilities: { kind: "structured" }, kind: "resolved" });
  });

  test("Architecture insert props remain source-authoritative", () => {
    installProjectedMermaidTestTheme();
    const fixture = MERMAID_11_DIAGRAM_FIXTURES.find(
      ({ diagramType }) => diagramType === "architecture",
    )!;
    const props = createMermaidBlockInsertProps({ source: fixture.source });

    expect(props.diagramType).toBe("architecture");
    expect(props).not.toHaveProperty("visualModel");
    expect(props).not.toHaveProperty("visualModelHash");
    expect(props).not.toHaveProperty("layoutHash");
  });

  test("other graph-GFX product types are visual-model-first rather than source-first insert props", () => {
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) =>
        isMermaidGraphGfxDiagramType(diagramType) &&
        diagramType !== "architecture" &&
        diagramType !== "gantt" &&
        diagramType !== "timeline",
    )) {
      const props = createMermaidBlockInsertProps({ source: fixture.source });

      expect(props.diagramType).toBe(fixture.diagramType);
      expect(props).not.toHaveProperty("visualModel");
      expect(props).not.toHaveProperty("visualModelHash");
      expect(props).not.toHaveProperty("layoutHash");
    }
  });

  test("keeps non-GFX Mermaid 11.12 diagram families source-first instead of unknown", () => {
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) =>
        diagramType !== "flowchart" &&
        diagramType !== "flowchart-elk" &&
        diagramType !== "gantt" &&
        diagramType !== "journey" &&
        diagramType !== "packet" &&
        diagramType !== "timeline" &&
        !isMermaidChartFacadeType(diagramType) &&
        !isMermaidGraphGfxDiagramType(diagramType),
    )) {
      const props = createMermaidBlockInsertProps({ source: fixture.source });

      expect(props.diagramType).toBe(fixture.diagramType);
      expect(props).not.toHaveProperty("visualModel");
      expect(props).not.toHaveProperty("visualModelHash");
      expect(props.sourceHash).toBe(
        hashMermaidSource(
          resolveMermaidBlockInsertIdentity({ source: fixture.source }).source,
        ),
      );
    }
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) =>
        diagramType === "gantt" || diagramType === "timeline",
    )) {
      const props = createMermaidBlockInsertProps({ source: fixture.source });
      expect(props.diagramType).toBe(fixture.diagramType);
      expect(props).not.toHaveProperty("visualModelHash");
      expect(props).not.toHaveProperty("layoutHash");
    }
  });

  test("keeps non-GFX product diagrams source-first without stale host controls", () => {
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) =>
        diagramType !== "flowchart" &&
        diagramType !== "flowchart-elk" &&
        diagramType !== "gantt" &&
        diagramType !== "journey" &&
        diagramType !== "packet" &&
        diagramType !== "timeline" &&
        !isMermaidChartFacadeType(diagramType) &&
        !isMermaidGraphGfxDiagramType(diagramType),
    )) {
      const host = renderBlockForSource({ source: fixture.source });

      expect(
        host.querySelector(
          ".myoxus-mermaid-visual-canvas, .myoxus-mermaid-gfx-editor",
        ),
        fixture.diagramType,
      ).toBeFalsy();
      expect(
        host.querySelector(".myoxus-mermaid-structured-row"),
        fixture.diagramType,
      ).toBeFalsy();
      expect(
        host.querySelector(".myoxus-mermaid-controls"),
        fixture.diagramType,
      ).toBeFalsy();
      expect(
        host.querySelector("[aria-label='Template']"),
        fixture.diagramType,
      ).toBeFalsy();
      expect(
        host.querySelector("[aria-label='Layout']"),
        fixture.diagramType,
      ).toBeFalsy();
      expect(
        host.querySelector("[aria-label='Edge style']"),
        fixture.diagramType,
      ).toBeFalsy();
      expect(
        host.querySelector("[aria-label='Palette']"),
        fixture.diagramType,
      ).toBeFalsy();
      if (fixture.diagramType === "kanban") {
        expect(
          host.querySelector(".myoxus-mermaid-kanban-editor"),
        ).toBeTruthy();
      } else {
        expect(host.textContent, fixture.diagramType).toContain(
          "Source-first diagram",
        );
      }
      if (fixture.diagramType === "kanban") {
        expect(host.querySelector(".myoxus-mermaid-source")).toBeNull();
        expect(host.querySelector(".myoxus-mermaid-preview")).toBeNull();
      } else {
        expect(
          host.querySelector(".myoxus-mermaid-source") !== null,
          fixture.diagramType,
        ).toBe(true);
        expect(
          host.querySelector(".myoxus-mermaid-preview") !== null,
          fixture.diagramType,
        ).toBe(true);
      }
      if (fixture.diagramType === "kanban") {
        const modeControl = host.querySelector(
          '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
        );
        expect(modeControl).toBeTruthy();
        expect(modeControl?.textContent).toContain("Visual");
        expect(modeControl?.textContent).toContain("Source");
      } else {
        const modeControl = host.querySelector(
          '[data-myoxus-ui-role="mermaid-editor-mode-control"]',
        );
        expect(modeControl?.textContent, fixture.diagramType).toContain(
          "Source",
        );
        expect(modeControl?.textContent, fixture.diagramType).not.toContain(
          "Visual",
        );
      }
    }
  });

  test("graph-GFX Mermaid families bypass legacy source-first visual dispatch", () => {
    installProjectedMermaidTestTheme();
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) =>
        isMermaidGraphGfxDiagramType(diagramType) &&
        diagramType !== "gantt" &&
        diagramType !== "timeline",
    )) {
      const visualModel = parseMermaidSourceToGfxVisualModel(
        fixture.source,
      ).model;

      expect(visualModel).toBeTruthy();
      expect(
        resolveMermaidFamilyRuntime(fixture.source, visualModel).kind,
      ).toBe("resolved");
    }
  });

  test("renders Architecture through its owner GFX owner and never the structured editor", () => {
    installProjectedMermaidTestTheme();
    const fixture = MERMAID_11_DIAGRAM_FIXTURES.find(
      ({ diagramType }) => diagramType === "architecture",
    )!;
    const host = renderVisualEditorForSource(fixture.source);

    expect(
      host.querySelector(
        '.myoxus-mermaid-gfx-editor[data-diagram-type="architecture"]',
      ),
    ).toBeTruthy();
    expect(host.querySelector(".myoxus-mermaid-structured-row")).toBeFalsy();
    expect(host.textContent).not.toContain("Source-first diagram");
  });

  test("does not render the remaining Mermaid product fixtures through the structured editor", () => {
    for (const fixture of MERMAID_11_DIAGRAM_FIXTURES.filter(
      ({ diagramType }) => diagramType !== "architecture",
    )) {
      const host = renderVisualEditorForSource(fixture.source);
      const visualEditor = host.querySelector(
        '.myoxus-mermaid-visual-canvas, .myoxus-mermaid-gfx-editor, .myoxus-mermaid-temporal-editor, .myoxus-mermaid-kanban-editor, .myoxus-mermaid-chart-editor, .myoxus-mermaid-journey-editor, .myoxus-mermaid-packet-editor, [data-testid="mermaid-pie-view"], [data-testid="mermaid-sankey-view"]',
      );
      const structuredRow = host.querySelector(
        ".myoxus-mermaid-structured-row",
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
        expect(visualEditor, fixture.diagramType).toBeFalsy();
        expect(structuredRow, fixture.diagramType).toBeFalsy();
        expect(host.textContent, fixture.diagramType).toContain(
          "Source-first diagram",
        );
        continue;
      }

      expect(visualEditor, fixture.diagramType).toBeTruthy();
      expect(structuredRow, fixture.diagramType).toBeFalsy();
      expect(host.textContent, fixture.diagramType).not.toContain(
        "Source-first diagram",
      );
    }
  });

  test("preserves supported flowchart click statements on the visual path", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start] --> B[Done]\n  click A callback\n",
    );

    expect(parsed.diagramType).toBe("flowchart");
    expect(parsed.model?.styleStatements).toContain("click A callback");
    expect(
      createMermaidBlockInsertProps({
        source: "flowchart TD\n  A[Start] --> B[Done]\n  click A callback\n",
      }),
    ).not.toHaveProperty("visualModelHash");
  });

  test("first-class insert props persist source without a visual DTO", () => {
    const props = createMermaidBlockInsertProps({
      source: "flowchart TD\n  A[Start] --> B[Done]\n",
      title: "Flow",
    });
    expect(props).not.toHaveProperty("reference");
    expect(props.sourceHash).toMatch(/^fnv1a:/);
    expect(props).not.toHaveProperty("visualModel");
    expect(props).not.toHaveProperty("visualModelHash");
  });

  test("first-class insert props preserve unsupported source-first Mermaid without forcing a frame", () => {
    const props = createMermaidBlockInsertProps({
      source: "info\n  showInfo\n",
      title: "Info",
    });

    expect(props.flavour).toBe("myoxus:mermaid");
    expect(props).not.toHaveProperty("reference");
    expect(props.diagramType).toBe("unknown");
    expect(props).not.toHaveProperty("visualModel");
    expect(props).not.toHaveProperty("visualModelHash");
    expect(props.sourceHash).toBe(hashMermaidSource("info\n  showInfo\n"));
  });

  test("insert command rejects Mermaid source without a resolved runtime", () => {
    const targetModel = {
      id: "paragraph-1",
      text: { length: 1 },
    };
    let addedProps: ReturnType<typeof createMermaidBlockInsertProps> | null =
      null;
    let nextPayload: {
      insertedMermaidBlockId: string;
      insertedMermaidDiagram: {
        ownerId: string | null;
        sourceHash: string;
        visualModelHash: string | null;
      };
    } | null = null;

    insertMermaidBlockCommand(
      {
        selectedModels: [targetModel],
        source: "info\n  showInfo\n",
        std: {
          store: {
            addSiblingBlocks: (_target: unknown, blocks: unknown[]) => {
              addedProps = blocks[0] as ReturnType<
                typeof createMermaidBlockInsertProps
              >;
              return ["mermaid-1"];
            },
            captureSync: () => undefined,
            getParent: (model: unknown) =>
              model === targetModel ? { id: "root" } : null,
          },
          selection: {
            create: (_selection: unknown, payload: unknown) => payload,
            set: () => undefined,
          },
        },
      } as never,
      (payload: unknown) => {
        nextPayload = payload as typeof nextPayload;
      },
    );

    expect(addedProps).toBeNull();
    expect(nextPayload).toBeNull();
  });

  test("exports Markdown as a Mermaid fence, not a placeholder", async () => {
    const markdownNodes: unknown[] = [];
    const source =
      '---\ntitle: "Greeting"\n---\nsequenceDiagram\n  Alice->>Bob: Hello';
    const node = createMermaidBlockSnapshot(
      "sequenceDiagram\n  Alice->>Bob: Hello",
      "Greeting",
    );

    await mermaidBlockMarkdownAdapterMatcher.fromBlockSnapshot.enter!(
      { node } as never,
      {
        walkerContext: {
          openNode: (nextNode: unknown) => {
            markdownNodes.push(nextNode);
            return { closeNode: () => undefined };
          },
        },
      } as never,
    );

    expect(markdownNodes).toEqual([
      {
        type: "code",
        lang: "mermaid",
        meta: null,
        value: source,
      },
    ]);
    expect(getMermaidBlockSource(node.props)).toBe(source);
  });

  test("keeps slash access hidden unless schema and feature flag are both active", () => {
    expect(
      canShowMermaidSlashItem(
        createSlashContext({ flag: false, schemaRegistered: true }),
      ),
    ).toBe(false);
    expect(
      canShowMermaidSlashItem(
        createSlashContext({ flag: true, schemaRegistered: false }),
      ),
    ).toBe(false);
    expect(
      canShowMermaidSlashItem(
        createSlashContext({ flag: true, schemaRegistered: true }),
      ),
    ).toBe(true);
  });

  test("offers every first-class Mermaid diagram type from the slash menu instead of silently inserting a flowchart", () => {
    const rootItem = Array.isArray(mermaidSlashMenuConfig.items)
      ? mermaidSlashMenuConfig.items[0]
      : mermaidSlashMenuConfig.items(
          createSlashContext({ flag: true, schemaRegistered: true }),
        )[0];
    expect("subMenu" in rootItem).toBe(true);
    if (!("subMenu" in rootItem)) return;

    expect(rootItem.subMenu).toHaveLength(MERMAID_PRODUCT_TEMPLATES.length);
    expect(rootItem.id).toBe("mermaid");
    expect(rootItem.subMenu.map((item) => item.id)).toEqual(
      MERMAID_PRODUCT_TEMPLATES.map(({ id }) => `mermaid-${id}`),
    );
    const descriptionText = (
      description: (typeof rootItem.subMenu)[number]["description"],
    ) =>
      typeof description === "string" ? description : description?.fallback;
    expect(
      new Set(
        rootItem.subMenu.map((item) => descriptionText(item.description)),
      ),
    ).toEqual(new Set(["Create a Mermaid diagram"]));
    expect(
      rootItem.subMenu.some((item) =>
        /tested|experimental/i.test(descriptionText(item.description) ?? ""),
      ),
    ).toBe(false);
  });

  test("slash menu template actions pass the selected diagram source to the insert command", () => {
    const rootItem = Array.isArray(mermaidSlashMenuConfig.items)
      ? mermaidSlashMenuConfig.items[0]
      : mermaidSlashMenuConfig.items(
          createSlashContext({ flag: true, schemaRegistered: true }),
        )[0];
    expect("subMenu" in rootItem).toBe(true);
    if (!("subMenu" in rootItem)) return;
    const sequenceItem = rootItem.subMenu.find(
      (item) => item.id === "mermaid-sequence-basic",
    );
    expect(sequenceItem && "action" in sequenceItem).toBe(true);
    if (!sequenceItem || !("action" in sequenceItem)) return;
    const execCalls: unknown[] = [];
    const context = {
      model: {},
      std: {
        command: {
          exec: (...args: unknown[]) => {
            execCalls.push(args);
            return [true, {}];
          },
        },
      },
    } as unknown as SlashMenuContext;

    sequenceItem.action(context);

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual([
      insertMermaidBlockCommand,
      expect.objectContaining({
        source: expect.stringMatching(/^sequenceDiagram\b/),
        title: "Sequence",
      }),
    ]);

    execCalls.length = 0;
    const kanbanItem = rootItem.subMenu.find(
      (item) => item.id === "mermaid-kanban-basic",
    );
    expect(kanbanItem && "action" in kanbanItem).toBe(true);
    if (!kanbanItem || !("action" in kanbanItem)) return;

    kanbanItem.action(context);

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual([
      insertMermaidBlockCommand,
      expect.objectContaining({
        source: expect.stringMatching(/^kanban\b/),
        title: "Kanban",
      }),
    ]);
  });

  test("offers GFX-materializable Mermaid diagram types from the native Edgeless toolbar", () => {
    const labels = getMermaidEdgelessToolbarTemplates().map(
      (template) => template.label,
    );
    const diagramTypes = getMermaidEdgelessToolbarTemplates().map(
      (template) => template.diagramType,
    );
    expect(labels).toContain("Flowchart");
    expect(labels).toContain("Sequence");
    expect(labels).toContain("Gantt");
    expect(labels).toContain("Git graph");
    expect(labels).toContain("Packet");
    expect(labels).toContain("Pie");
    expect(labels).toContain("Quadrant");
    expect(labels).toContain("Radar");
    expect(labels).toContain("XY chart");
    expect(
      diagramTypes.every((diagramType) =>
        isMermaidFamilyVisualEditingDiagramType(diagramType),
      ),
    ).toBe(true);
  });

  test("Edgeless toolbar template selection passes the chosen diagram source to the Edgeless insert command", async () => {
    const execCalls: unknown[] = [];
    const edgeless = {
      store: { readonly: false },
      std: {
        command: {
          exec: (...args: unknown[]) => {
            execCalls.push(args);
            return [true, {}];
          },
        },
      },
    };
    const sequenceTemplate = getMermaidEdgelessToolbarTemplates().find(
      (template) => template.label === "Sequence",
    );
    expect(sequenceTemplate).toBeTruthy();
    if (!sequenceTemplate) return;

    await insertMermaidEdgelessToolbarTemplate(
      edgeless as never,
      sequenceTemplate,
    );

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual([
      insertMermaidEdgelessDiagramCommand,
      expect.objectContaining({
        source: expect.stringMatching(/^sequenceDiagram\b/),
        title: "Sequence",
      }),
    ]);
  });

  test("registers the first-class Mermaid custom elements", () => {
    effects();
    expect(customElements.get("myoxus-mermaid")).toBeTruthy();
    expect(customElements.get("edgeless-mermaid-tool-button")).toBeTruthy();
  });
});
