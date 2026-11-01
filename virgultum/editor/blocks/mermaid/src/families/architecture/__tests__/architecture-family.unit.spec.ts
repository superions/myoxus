// SPDX-License-Identifier: AGPL-3.0-or-later

import { afterEach, describe, expect, test, vi } from "vitest";

import {
  addMermaidArchitectureComment,
  deleteMermaidArchitectureComment,
  deleteMermaidArchitectureAlignment,
  generateMermaidArchitectureSource,
  mermaidArchitectureDiagramConfig,
  parseMermaidArchitectureSource,
  setMermaidArchitectureAlignment,
  updateMermaidArchitectureEdge,
  updateMermaidArchitectureGroup,
  updateMermaidArchitectureService,
  updateMermaidArchitectureComment,
  updateMermaidArchitectureDiagram,
  updateMermaidArchitectureAlignment,
} from "../../../engine/architecture/index.js";
import {
  MermaidGfxThemeUnavailableError,
  resolveMermaidGfxTheme,
} from "../../../mermaid-gfx-theme.js";
import { mermaidRequirementFamily } from "../../requirement/family.js";
import { getMermaidFamilyRuntime } from "../../runtime/registry.js";
import {
  architectureModelFamilyData,
  architectureNodeGfxData,
} from "../gfx-data.js";
import { architectureCommentAnchorLabel } from "../interaction-controller.js";
import { layoutArchitectureGfxModel } from "../layout/index.js";
import { mermaidArchitectureFamily } from "../family.js";
import { mermaidArchitectureGfxHookRegistration } from "../runtime-hooks.js";
import { applyArchitectureSemanticFieldMutations } from "../mutations/index.js";
import { applyArchitectureGfxVisualToSource } from "../source-application.js";
import { architectureModelToGfxVisualModel } from "../visual-model.js";
import { reconcileArchitectureVisualProjection } from "../visual-reconciliation.js";

const SOURCE = [
  "---",
  'title: "Runtime architecture"',
  "---",
  '%%{init: {"flowchart":{"curve":"linear"}}}%%',
  "%% Diagram comment",
  "architecture-beta %% Header comment",
  "accTitle: Architecture diagram",
  "accDescr: Nested services and their connections",
  '  group platform(cloud)["Platform"] %% Group comment',
  '  group core(server)["Core services"] in platform',
  '  service gateway(server)["Gateway"] in core',
  '  service application "API" ["Application service with a deliberately long label"] in core',
  '  service database(database)["Primary database"] in platform',
  "  junction bus in platform %% Junction comment",
  '  gateway:R -["HTTPS"]-> L:application',
  "  application:R --> L:bus",
  '  bus:R -["events"]-> L:database',
  "  align row gateway application",
  "  align column application bus database",
].join("\n");

const RUNTIME_LEDGER_SOURCE = [
  "---",
  "title: Ledger architecture",
  "---",
  '%%{init: {"architecture":{"padding":42,"iconSize":72,"fontSize":15,"randomize":false,"nodeSeparation":88,"idealEdgeLengthMultiplier":1.75,"edgeElasticity":0.4,"numIter":1200,"seed":7}}}%%',
  "%% Before header",
  "architecture-beta %% After header",
  "title Ledger body title",
  "accTitle: Ledger accessibility",
  "accDescr {",
  "  Multiline architecture",
  "  description",
  "}",
  'group private(cloud)["Private"] %% Group comment',
  'group public(internet)["Public"]',
  'service plain["No icon"] in private',
  'service api(server)["API"] in public',
  'service worker "W" ["Worker"] in public',
  "junction bus in private",
  'plain{group}:R <-["request"]-> L:api{group}',
  "bus:T --> B:worker",
  "worker:B --> T:worker",
  "align row plain api",
  "align column api worker bus",
].join("\n");

test("returns typed Architecture comment command outcomes", () => {
  const model = parseMermaidArchitectureSource(SOURCE)!;
  const added = addMermaidArchitectureComment(
    model,
    { anchorId: "gateway", anchorKind: "service" },
    "Gateway owner",
  );
  const commentId = added.selectionAfter.id!;
  const updated = updateMermaidArchitectureComment(
    added.model,
    commentId,
    "Gateway team",
  );
  const removed = deleteMermaidArchitectureComment(updated.model, commentId);
  const empty = addMermaidArchitectureComment(
    model,
    { anchorKind: "diagram" },
    "  ",
  );

  expect(added).toMatchObject({
    changed: true,
    focusAfter: "comment",
    selectionAfter: { kind: "comment" },
  });
  expect(updated).toMatchObject({
    changed: true,
    selectionAfter: { id: commentId, kind: "comment" },
  });
  expect(removed).toMatchObject({
    changed: true,
    focusAfter: "canvas",
    selectionAfter: { kind: "diagram" },
  });
  expect(empty).toMatchObject({
    changed: false,
    diagnosis: { code: "architecture.comment-empty" },
    model,
  });
});

test("renames Architecture objects atomically without relocating their source", () => {
  const model = parseMermaidArchitectureSource(SOURCE)!;
  const withComment = addMermaidArchitectureComment(
    model,
    { anchorId: "gateway", anchorKind: "service" },
    "Gateway owner",
  ).model;
  const renamed = updateMermaidArchitectureService(withComment, "gateway", {
    id: "edge_gateway",
  });

  expect(renamed).toMatchObject({
    changed: true,
    selectionAfter: { id: "edge_gateway", kind: "service" },
  });
  expect(renamed.model.edges[0]).toMatchObject({ from: "edge_gateway" });
  expect(renamed.model.alignments[0]?.members).toContain("edge_gateway");
  expect(
    renamed.model.comments?.find(
      (comment) => comment.line === "%% Gateway owner",
    ),
  ).toMatchObject({ anchorId: "edge_gateway", anchorKind: "service" });

  const source = generateMermaidArchitectureSource(renamed.model);
  expect(source).toContain('service edge_gateway(server)["Gateway"] in core');
  expect(source.indexOf("service edge_gateway")).toBeLessThan(
    source.indexOf("service application"),
  );
  expect(source).toContain('%%{init: {"flowchart":{"curve":"linear"}}}%%');
  expect(parseMermaidArchitectureSource(source)).toMatchObject({
    alignments: expect.arrayContaining([
      expect.objectContaining({
        members: expect.arrayContaining(["edge_gateway", "application"]),
      }),
    ]),
    edges: expect.arrayContaining([
      expect.objectContaining({ from: "edge_gateway", to: "application" }),
    ]),
  });

  const duplicate = updateMermaidArchitectureService(model, "gateway", {
    id: "application",
  });
  const invalid = updateMermaidArchitectureService(model, "gateway", {
    id: "invalid id",
  });
  expect(duplicate).toMatchObject({
    changed: false,
    diagnosis: { code: "architecture.id-invalid-or-duplicate" },
    model,
  });
  expect(invalid).toMatchObject({
    changed: false,
    diagnosis: { code: "architecture.id-invalid-or-duplicate" },
    model,
  });
});

test("preserves Architecture group and edge invariants before mutation", () => {
  const model = parseMermaidArchitectureSource(SOURCE)!;
  const renamed = updateMermaidArchitectureGroup(model, "platform", {
    id: "foundation",
  });

  expect(renamed).toMatchObject({ changed: true });
  expect(
    renamed.model.groups.find((group) => group.id === "core"),
  ).toMatchObject({ parentId: "foundation" });
  expect(
    renamed.model.services.find((service) => service.id === "database"),
  ).toMatchObject({ groupId: "foundation" });
  expect(renamed.model.junctions[0]).toMatchObject({ groupId: "foundation" });
  expect(renamed.model.comments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ anchorId: "foundation", anchorKind: "group" }),
    ]),
  );
  expect(generateMermaidArchitectureSource(renamed.model)).toContain(
    'group foundation(cloud)["Platform"]',
  );

  const cycle = updateMermaidArchitectureGroup(model, "platform", {
    parentId: "core",
  });
  const self = updateMermaidArchitectureGroup(model, "core", {
    id: "renamed_core",
    parentId: "core",
  });
  const invalidEdge = updateMermaidArchitectureEdge(model, model.edges[0].id, {
    fromPort: "X",
  });
  const invalidGroupEndpoint = updateMermaidArchitectureEdge(
    model,
    model.edges[0].id,
    { from: "application", fromGroup: true },
  );
  expect(cycle.diagnosis?.code).toBe("architecture.parent-invalid");
  expect(self.diagnosis?.code).toBe("architecture.parent-invalid");
  expect(invalidEdge.diagnosis?.code).toBe("architecture.edge-port-invalid");
  expect(invalidGroupEndpoint.diagnosis?.code).toBe(
    "architecture.edge-group-endpoint-invalid",
  );
  expect(
    [cycle, self, invalidEdge, invalidGroupEndpoint].every(
      (result) => !result.changed && result.model === model,
    ),
  ).toBe(true);
});

test("owns Architecture alignment semantics and anchored comment cleanup", () => {
  const model = parseMermaidArchitectureSource(
    [
      "architecture-beta",
      'group platform(cloud)["Platform"]',
      'service gateway(server)["Gateway"] in platform',
      'service database(database)["Database"] in platform',
    ].join("\n"),
  )!;
  const rejected = setMermaidArchitectureAlignment(
    model,
    ["platform", "gateway"],
    "row",
  );
  expect(rejected).toMatchObject({
    changed: false,
    diagnosis: { code: "architecture.alignment-members-invalid" },
    model,
  });

  const aligned = setMermaidArchitectureAlignment(
    model,
    ["gateway", "database"],
    "column",
  );
  const alignmentId = aligned.selectionAfter.id!;
  const reordered = updateMermaidArchitectureAlignment(
    aligned.model,
    alignmentId,
    ["database", "gateway"],
    "row",
  );
  expect(reordered.model.alignments).toHaveLength(
    aligned.model.alignments.length,
  );
  expect(reordered.selectionAfter.id).toBe(alignmentId);
  expect(
    reordered.model.alignments.find(
      (alignment) => alignment.id === alignmentId,
    ),
  ).toMatchObject({
    direction: "row",
    members: ["database", "gateway"],
  });
  const withComment = addMermaidArchitectureComment(
    reordered.model,
    { anchorId: alignmentId, anchorKind: "alignment" },
    "Keep vertically aligned",
  ).model;
  const removed = deleteMermaidArchitectureAlignment(withComment, alignmentId);

  expect(aligned).toMatchObject({ changed: true });
  expect(removed).toMatchObject({
    changed: true,
    selectionAfter: { kind: "diagram" },
  });
  expect(removed.model.alignments).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ id: alignmentId })]),
  );
  expect(removed.model.comments).not.toEqual(
    expect.arrayContaining([
      expect.objectContaining({ anchorId: alignmentId }),
    ]),
  );
  expect(removed.model.sourceAnnotations).not.toContain(
    "%% Keep vertically aligned",
  );
});

function installProjectedTheme() {
  const values: Record<string, string> = {
    "--myoxus-background-primary-color": "rgb(255, 255, 255)",
    "--myoxus-background-error-color": "rgb(255, 225, 225)",
    "--myoxus-background-processing-color": "rgb(225, 240, 255)",
    "--myoxus-background-secondary-color": "rgb(245, 245, 245)",
    "--myoxus-background-success-color": "rgb(230, 250, 235)",
    "--myoxus-background-warning-color": "rgb(255, 240, 215)",
    "--myoxus-border-color": "rgb(80, 80, 80)",
    "--myoxus-error-color": "rgb(175, 55, 55)",
    "--myoxus-primary-color": "rgb(70, 90, 210)",
    "--myoxus-processing-color": "rgb(45, 105, 150)",
    "--myoxus-success-color": "rgb(30, 130, 70)",
    "--myoxus-text-primary-color": "rgb(20, 20, 20)",
    "--myoxus-text-secondary-color": "rgb(90, 90, 90)",
    "--myoxus-typography-body-family": "Inter",
    "--myoxus-typography-body-font-style": "normal",
    "--myoxus-typography-body-letter-spacing": "0px",
    "--myoxus-typography-body-line-height": "24px",
    "--myoxus-typography-body-size": "16px",
    "--myoxus-typography-body-small-size": "12px",
    "--myoxus-typography-body-weight": "400",
    "--myoxus-typography-h1-size": "24px",
    "--myoxus-typography-h3-size": "20px",
    "--myoxus-warning-color": "rgb(190, 95, 40)",
  };
  vi.stubGlobal(
    "getComputedStyle",
    () =>
      ({
        backgroundColor: values["--myoxus-background-primary-color"],
        borderBottomColor: values["--myoxus-background-success-color"],
        borderColor: values["--myoxus-border-color"],
        borderLeftColor: values["--myoxus-border-color"],
        borderRightColor: values["--myoxus-primary-color"],
        borderTopColor: values["--myoxus-background-secondary-color"],
        color: values["--myoxus-text-primary-color"],
        fontFamily: values["--myoxus-typography-body-family"],
        fontSize: values["--myoxus-typography-body-size"],
        fontStyle: values["--myoxus-typography-body-font-style"],
        fontWeight: values["--myoxus-typography-body-weight"],
        getPropertyValue: (property: string) => values[property] ?? "",
        letterSpacing: values["--myoxus-typography-body-letter-spacing"],
        lineHeight: values["--myoxus-typography-body-line-height"],
        outlineColor: values["--myoxus-text-secondary-color"],
        textDecorationColor: values["--myoxus-success-color"],
      }) as CSSStyleDeclaration,
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    font: "",
    measureText(text: string) {
      return { width: Array.from(text).length * 8 } as TextMetrics;
    },
  } as CanvasRenderingContext2D);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Mermaid Architecture family", () => {
  test("is accepted by the resolved Mermaid 11.16 runtime", async () => {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false });
    await expect(mermaid.parse(SOURCE)).resolves.toBeTruthy();
    await expect(mermaid.parse(RUNTIME_LEDGER_SOURCE)).resolves.toBeTruthy();
    await expect(
      mermaid.parse(
        [
          "architecture-beta",
          '  group private(cloud)["Private"]',
          '  group public(internet)["Public"]',
          '  private{group}:R -["boundary"]-> L:public{group}',
        ].join("\n"),
      ),
    ).rejects.toThrow();
  });

  test("roundtrips the full runtime grammar with stable positioned comments", () => {
    const model = parseMermaidArchitectureSource(SOURCE);

    expect(model).not.toBeNull();
    expect(model).toMatchObject({
      accessibilityDescription: "Nested services and their connections",
      accessibilityTitle: "Architecture diagram",
      diagramTitle: "Runtime architecture",
      directives: ['%%{init: {"flowchart":{"curve":"linear"}}}%%'],
    });
    expect(model?.groups.map(({ id, parentId }) => [id, parentId])).toEqual([
      ["platform", ""],
      ["core", "platform"],
    ]);
    expect(model?.services).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          groupId: "core",
          icon: "API",
          iconKind: "text",
          id: "application",
        }),
      ]),
    );
    expect(model?.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "gateway",
          fromArrow: false,
          fromPort: "R",
          label: "HTTPS",
          to: "application",
          toArrow: true,
          toPort: "L",
        }),
      ]),
    );
    expect(model?.alignments.map(({ direction }) => direction)).toEqual([
      "row",
      "column",
    ]);
    expect(
      model?.comments?.map(({ anchorId, anchorKind, line, position }) => ({
        anchorId,
        anchorKind,
        line,
        position,
      })),
    ).toEqual([
      {
        anchorId: undefined,
        anchorKind: "diagram",
        line: "%% Diagram comment",
        position: "before",
      },
      {
        anchorId: undefined,
        anchorKind: "diagram",
        line: "%% Header comment",
        position: "after",
      },
      {
        anchorId: "platform",
        anchorKind: "group",
        line: "%% Group comment",
        position: "after",
      },
      {
        anchorId: "bus",
        anchorKind: "junction",
        line: "%% Junction comment",
        position: "after",
      },
    ]);
    expect(generateMermaidArchitectureSource(model!)).toBe(SOURCE);

    const changed = {
      ...model!,
      services: model!.services.map((service) =>
        service.id === "gateway"
          ? { ...service, icon: "database", iconKind: "icon" as const }
          : service,
      ),
    };
    const nextSource = generateMermaidArchitectureSource(changed);
    expect(nextSource).toContain(
      'service gateway(database)["Gateway"] in core',
    );
    expect(nextSource).toContain("%% Group comment");
    expect(nextSource).toContain('gateway:R -["HTTPS"]-> L:application');
    expect(parseMermaidArchitectureSource(nextSource)?.comments).toEqual(
      model?.comments,
    );
  });

  test("roundtrips the complete runtime ledger source byte-for-byte", () => {
    const model = parseMermaidArchitectureSource(RUNTIME_LEDGER_SOURCE);
    expect(model).not.toBeNull();
    expect(generateMermaidArchitectureSource(model!)).toBe(
      RUNTIME_LEDGER_SOURCE,
    );
    expect(
      new Set(model?.edges.flatMap((edge) => [edge.fromPort, edge.toPort])),
    ).toEqual(new Set(["L", "R", "T", "B"]));
    expect(model?.edges[0]).toMatchObject({
      fromArrow: true,
      fromGroup: true,
      label: "request",
      toArrow: true,
      toGroup: true,
    });
    expect(model?.edges[2]).toMatchObject({ from: "worker", to: "worker" });
  });

  test("updates Architecture settings while preserving unrelated init config", () => {
    const source = [
      '%%{init: {"flowchart": { "curve": "linear" },"architecture":{"padding":42},"theme":"base"}}}%%',
      "architecture-beta",
      '  service api(server)["API"]',
    ].join("\n");
    const model = parseMermaidArchitectureSource(source)!;
    const command = updateMermaidArchitectureDiagram(model, {
      accessibilityDescription: "Primary service topology",
      accessibilityTitle: "Service architecture",
      config: {
        edgeElasticity: 0.4,
        fontSize: 15,
        iconSize: 72,
        idealEdgeLengthMultiplier: 1.75,
        nodeSeparation: 88,
        numIter: 1200,
        padding: 48,
        randomize: false,
        seed: 7,
      },
    });

    expect(command).toMatchObject({
      changed: true,
      focusAfter: "canvas",
      selectionAfter: { kind: "diagram" },
    });
    const written = generateMermaidArchitectureSource(command.model);
    expect(written).toContain('"flowchart": { "curve": "linear" }');
    expect(written).toContain(',"theme":"base"');
    expect(written.indexOf("%%{init:")).toBeLessThan(
      written.indexOf("architecture-beta"),
    );
    const reparsed = parseMermaidArchitectureSource(written)!;
    expect(reparsed.accessibilityTitle).toBe("Service architecture");
    expect(reparsed.accessibilityDescription).toBe("Primary service topology");
    expect(mermaidArchitectureDiagramConfig(reparsed)).toEqual({
      edgeElasticity: 0.4,
      fontSize: 15,
      iconSize: 72,
      idealEdgeLengthMultiplier: 1.75,
      nodeSeparation: 88,
      numIter: 1200,
      padding: 48,
      randomize: false,
      seed: 7,
    });
  });

  test("resets only Architecture config and rejects invalid values", () => {
    const model = parseMermaidArchitectureSource(
      [
        '%%{init: {"flowchart":{"curve":"linear"},"architecture":{"padding":42}}}%%',
        "architecture-beta",
        '  service api(server)["API"]',
      ].join("\n"),
    )!;
    const invalid = updateMermaidArchitectureDiagram(model, {
      config: { edgeElasticity: 2 },
    });
    expect(invalid).toMatchObject({
      changed: false,
      diagnosis: { code: "architecture.config-invalid" },
    });

    const reset = updateMermaidArchitectureDiagram(model, { config: {} });
    const written = generateMermaidArchitectureSource(reset.model);
    expect(written).toContain('"flowchart":{"curve":"linear"}');
    expect(written).not.toContain('"architecture"');
    expect(
      mermaidArchitectureDiagramConfig(
        parseMermaidArchitectureSource(written)!,
      ),
    ).toEqual({});
  });

  test("applies diagram settings through the Architecture GFX source boundary", () => {
    installProjectedTheme();
    const model = parseMermaidArchitectureSource(SOURCE)!;
    const changed = updateMermaidArchitectureDiagram(model, {
      accessibilityTitle: "Runtime topology",
      config: {
        edgeElasticity: 0.8,
        fontSize: 24,
        iconSize: 96,
        idealEdgeLengthMultiplier: 3,
        nodeSeparation: 96,
        numIter: 2_000,
        padding: 64,
        randomize: true,
        seed: 11,
      },
    });
    const reprojected = architectureModelToGfxVisualModel(changed.model);
    const visual = reconcileArchitectureVisualProjection(
      reprojected,
      architectureModelToGfxVisualModel(model),
      { preserveGeometry: false },
    )!;
    const written = applyArchitectureGfxVisualToSource(SOURCE, visual);
    const reparsed = parseMermaidArchitectureSource(written)!;

    expect(reparsed.accessibilityTitle).toBe("Runtime topology");
    expect(mermaidArchitectureDiagramConfig(reparsed)).toEqual({
      edgeElasticity: 0.8,
      fontSize: 24,
      iconSize: 96,
      idealEdgeLengthMultiplier: 3,
      nodeSeparation: 96,
      numIter: 2_000,
      padding: 64,
      randomize: true,
      seed: 11,
    });
    expect(written).toContain('"flowchart":{"curve":"linear"}');
  });

  test("writes an explicit false setting from the live GFX projection", () => {
    installProjectedTheme();
    const source = [
      '%%{init: {"architecture":{"padding":48,"iconSize":72,"fontSize":15,"nodeSeparation":88,"idealEdgeLengthMultiplier":1.75,"edgeElasticity":0.4,"numIter":1200,"seed":7}}}%%',
      "architecture-beta",
      "  accTitle: Platform system map QA",
      "  accDescr: Nested services, boundaries, and event flow",
      '  service gateway(internet)["Gateway"]',
    ].join("\n");
    const parsed = parseMermaidArchitectureSource(source)!;
    const visual = architectureModelToGfxVisualModel(parsed);
    const changed = updateMermaidArchitectureDiagram(parsed, {
      config: {
        ...mermaidArchitectureDiagramConfig(parsed),
        randomize: false,
      },
    });
    const projected = {
      ...visual,
      familyData: architectureModelFamilyData(
        changed.model.alignments,
        changed.model.comments,
        {
          config: mermaidArchitectureDiagramConfig(changed.model),
          directives: changed.model.directives,
        },
      ),
    };

    const written = applyArchitectureGfxVisualToSource(source, projected);
    expect(written).toContain('"randomize":false');
    expect(
      mermaidArchitectureDiagramConfig(parseMermaidArchitectureSource(written)!)
        .randomize,
    ).toBe(false);

    const withExplicitFalse = parseMermaidArchitectureSource(written)!;
    const reset = updateMermaidArchitectureDiagram(withExplicitFalse, {
      config: {},
    });
    const resetVisual = {
      ...architectureModelToGfxVisualModel(withExplicitFalse),
      familyData: architectureModelFamilyData(
        reset.model.alignments,
        reset.model.comments,
        { config: {}, directives: reset.model.directives },
      ),
    };
    const resetSource = applyArchitectureGfxVisualToSource(
      written,
      resetVisual,
    );
    expect(resetSource).not.toContain("%%{init:");
    expect(
      mermaidArchitectureDiagramConfig(
        parseMermaidArchitectureSource(resetSource)!,
      ),
    ).toEqual({});
  });

  test("preserves directives at their physical anchors and valid ungrouped group endpoints", () => {
    const source = [
      "---",
      "title: |",
      "  Anchored architecture",
      "---",
      "%%{init:",
      '  {"flowchart":{"curve":"linear"}}',
      "}%% architecture-beta",
      '  service api(server)["API"]',
      '  %%{wrap: {"padding": 2}}%% service db(database)["Database"]',
      '  api{group}:R -["reads"]-> L:db{group}',
    ].join("\n");

    const model = parseMermaidArchitectureSource(source);
    expect(model).not.toBeNull();
    expect(generateMermaidArchitectureSource(model!)).toBe(source);
    expect(model?.diagramTitle).toBe("Anchored architecture");
    expect(model?.edges[0]).toMatchObject({
      from: "api",
      fromGroup: true,
      to: "db",
      toGroup: true,
    });

    const changed = {
      ...model!,
      services: model!.services.map((service) =>
        service.id === "api" ? { ...service, label: "Gateway" } : service,
      ),
    };
    const changedSource = generateMermaidArchitectureSource(changed);
    expect(changedSource.match(/%%\{/g)).toHaveLength(2);
    expect(changedSource).toContain(
      '%%{wrap: {"padding": 2}}%% service db(database)["Database"]',
    );
    expect(parseMermaidArchitectureSource(changedSource)).not.toBeNull();
  });

  test("rejects direct group ids that Mermaid 11.16 cannot materialize", () => {
    const source = [
      "architecture-beta",
      '  group private(cloud)["Private"]',
      '  group public(internet)["Public"]',
      '  service api(server)["API"] in private',
      '  service gateway(server)["Gateway"] in public',
      '  private{group}:R -["boundary"]-> L:public{group}',
    ].join("\n");

    expect(parseMermaidArchitectureSource(source)).toBeNull();
  });

  test("derives finite intrinsic bounds from the projected theme", () => {
    installProjectedTheme();
    const model = parseMermaidArchitectureSource(SOURCE)!;
    const layout = layoutArchitectureGfxModel(model);
    const gateway = layout.nodes.find(({ id }) => id === "gateway")!;
    const application = layout.nodes.find(({ id }) => id === "application")!;
    const database = layout.nodes.find(({ id }) => id === "database")!;
    const bus = layout.nodes.find(({ id }) => id === "bus")!;
    const platform = layout.subgraphs.find(({ id }) => id === "platform")!;
    const core = layout.subgraphs.find(({ id }) => id === "core")!;
    const unalignedCore = layoutArchitectureGfxModel(
      parseMermaidArchitectureSource(
        SOURCE.replace("\n  align row gateway application", ""),
      )!,
    ).subgraphs.find(({ id }) => id === "core")!;

    expect(application.width).toBeGreaterThan(gateway.width);
    expect(
      [...layout.nodes, ...layout.subgraphs].every((item) =>
        [item.x, item.y, item.width, item.height].every(Number.isFinite),
      ),
    ).toBe(true);
    expect(platform.width).toBeGreaterThanOrEqual(
      database.x + database.width - platform.x,
    );
    expect(platform.height).toBeGreaterThanOrEqual(
      database.y + database.height - platform.y,
    );
    expect(core.height).toBeLessThan(unalignedCore.height);
    expect(bus.y).toBeGreaterThan(core.y + core.height);
    expect(architectureNodeGfxData(application)).toMatchObject({
      intrinsicHeight: application.height,
      intrinsicWidth: application.width,
      typographyKey: expect.stringContaining("Inter"),
    });
  });

  test("projects Architecture typography, icon, padding and separation config into GFX geometry", () => {
    installProjectedTheme();
    const source = [
      "architecture-beta",
      'group platform(cloud)["Platform"]',
      'service gateway(server)["Gateway"] in platform',
      'service worker "W" ["Worker"] in platform',
      "align row gateway worker",
    ].join("\n");
    const layoutFor = (config: Record<string, number>) =>
      layoutArchitectureGfxModel(
        parseMermaidArchitectureSource(
          `%%{init: {"architecture":${JSON.stringify(config)}}}%%\n${source}`,
        )!,
      );
    const compact = layoutFor({
      fontSize: 12,
      iconSize: 32,
      nodeSeparation: 24,
      padding: 16,
    });
    const spacious = layoutFor({
      fontSize: 24,
      iconSize: 96,
      nodeSeparation: 96,
      padding: 64,
    });
    const compactGateway = compact.nodes.find(({ id }) => id === "gateway")!;
    const spaciousGateway = spacious.nodes.find(({ id }) => id === "gateway")!;
    const compactWorker = compact.nodes.find(({ id }) => id === "worker")!;
    const spaciousWorker = spacious.nodes.find(({ id }) => id === "worker")!;
    const compactGroup = compact.subgraphs.find(({ id }) => id === "platform")!;
    const spaciousGroup = spacious.subgraphs.find(
      ({ id }) => id === "platform",
    )!;

    expect(spaciousGateway.width).toBeGreaterThan(compactGateway.width);
    expect(spaciousGateway.height).toBeGreaterThan(compactGateway.height);
    expect(spaciousWorker.x - spaciousGateway.x).toBeGreaterThan(
      compactWorker.x - compactGateway.x,
    );
    expect(spaciousGroup.width).toBeGreaterThan(compactGroup.width);
    expect(spaciousGroup.height).toBeGreaterThan(compactGroup.height);
  });

  test("uses Architecture edge length, elasticity and iterations for deterministic relaxation", () => {
    installProjectedTheme();
    const source = [
      "architecture-beta",
      'service gateway(server)["Gateway"]',
      'service application(server)["Application"]',
      "gateway:R --> L:application",
    ].join("\n");
    const distanceFor = (config: Record<string, number>) => {
      const layout = layoutArchitectureGfxModel(
        parseMermaidArchitectureSource(
          `%%{init: {"architecture":${JSON.stringify(config)}}}%%\n${source}`,
        )!,
      );
      const gateway = layout.nodes.find(({ id }) => id === "gateway")!;
      const application = layout.nodes.find(({ id }) => id === "application")!;
      return application.x - (gateway.x + gateway.width);
    };

    const short = distanceFor({
      edgeElasticity: 0.2,
      iconSize: 40,
      idealEdgeLengthMultiplier: 1,
      nodeSeparation: 8,
      numIter: 250,
    });
    const long = distanceFor({
      edgeElasticity: 0.8,
      iconSize: 80,
      idealEdgeLengthMultiplier: 3,
      nodeSeparation: 8,
      numIter: 2_000,
    });

    expect(long).toBeGreaterThan(short);
  });

  test("randomizes Architecture placement reproducibly from the configured seed", () => {
    installProjectedTheme();
    const source = [
      "architecture-beta",
      'service alpha(server)["Alpha"]',
      'service beta(server)["Beta"]',
      'service gamma(server)["Gamma"]',
      'service delta(server)["Delta"]',
    ].join("\n");
    const xOrderFor = (randomize: boolean, seed: number) => {
      const layout = layoutArchitectureGfxModel(
        parseMermaidArchitectureSource(
          `%%{init: {"architecture":{"randomize":${randomize},"seed":${seed}}}}%%\n${source}`,
        )!,
      );
      return [...layout.nodes]
        .sort((left, right) => left.x - right.x)
        .map(({ id }) => id);
    };

    expect(xOrderFor(false, 1)).toEqual(xOrderFor(false, 11));
    expect(xOrderFor(true, 7)).toEqual(xOrderFor(true, 7));
    expect(xOrderFor(true, 7)).not.toEqual(xOrderFor(true, 11));
  });

  test("applies semantic commands through the shared Page and Edgeless field adapter", () => {
    installProjectedTheme();
    const parsed = parseMermaidArchitectureSource(SOURCE)!;
    const withComment = addMermaidArchitectureComment(
      parsed,
      { anchorId: "gateway", anchorKind: "service" },
      "Node owner",
    ).model;
    const visualModel = architectureModelToGfxVisualModel(withComment);
    const converted = applyArchitectureSemanticFieldMutations(
      withComment,
      visualModel,
      { nodeId: "gateway" },
      [{ control: "architectureNodeKind", value: "junction" }],
    );

    expect(converted.changed).toBe(true);
    if (!converted.changed) return;
    expect(converted.model.services).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "gateway" })]),
    );
    expect(converted.model.junctions).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "gateway" })]),
    );
    const convertedGateway = converted.visualModel.nodes.find(
      ({ id }) => id === "gateway",
    );
    expect(convertedGateway).toBeDefined();
    expect(architectureNodeGfxData(convertedGateway!)).toMatchObject({
      kind: "junction",
    });

    const source = applyArchitectureGfxVisualToSource(
      generateMermaidArchitectureSource(withComment),
      converted.visualModel,
    );
    const reparsed = parseMermaidArchitectureSource(source)!;
    expect(source).toContain("junction gateway in core");
    expect(reparsed.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          anchorId: "gateway",
          anchorKind: "junction",
          line: "%% Node owner",
        }),
      ]),
    );

    const renamed = applyArchitectureSemanticFieldMutations(
      withComment,
      visualModel,
      { nodeId: "gateway" },
      [{ control: "architectureNodeId", value: "edge_gateway" }],
    );
    expect(renamed.changed).toBe(true);
    if (!renamed.changed) return;
    expect(renamed.selectionAfter).toEqual({
      id: "edge_gateway",
      kind: "service",
    });
    expect(renamed.model.services).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "edge_gateway" })]),
    );
    expect(renamed.model.edges[0]).toMatchObject({ from: "edge_gateway" });
    expect(renamed.model.alignments[0].members).toContain("edge_gateway");
    expect(renamed.model.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anchorId: "edge_gateway" }),
      ]),
    );
    expect(renamed.visualModel.nodes.map(({ id }) => id)).toContain(
      "edge_gateway",
    );
    expect(renamed.visualModel.edges[0]).toMatchObject({
      source: "edge_gateway",
    });
    const renamedSource = applyArchitectureGfxVisualToSource(
      SOURCE,
      renamed.visualModel,
    );
    expect(renamedSource).toContain(
      'service edge_gateway(server)["Gateway"] in core',
    );
    expect(renamedSource).toContain(
      'edge_gateway:R -["HTTPS"]-> L:application',
    );
    expect(parseMermaidArchitectureSource(renamedSource)?.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ anchorId: "edge_gateway" }),
      ]),
    );

    const reparsedRenamed = parseMermaidArchitectureSource(renamedSource)!;
    const rehydratedRenamedVisual =
      architectureModelToGfxVisualModel(reparsedRenamed);
    const renamedGroup = applyArchitectureSemanticFieldMutations(
      reparsedRenamed,
      rehydratedRenamedVisual,
      { subgraphId: "core" },
      [{ control: "architectureGroupId", value: "backend" }],
    );
    expect(renamedGroup.changed).toBe(true);
    if (!renamedGroup.changed) return;
    expect(renamedGroup.selectionAfter).toEqual({
      id: "backend",
      kind: "group",
    });
    expect(
      renamedGroup.model.services.find(({ id }) => id === "application"),
    ).toMatchObject({ groupId: "backend" });
    expect(renamedGroup.visualModel.subgraphs?.map(({ id }) => id)).toContain(
      "backend",
    );
    expect(
      architectureNodeGfxData(
        renamedGroup.visualModel.nodes.find(({ id }) => id === "application")!,
      ),
    ).toMatchObject({ groupId: "backend" });
    const renamedGroupSource = applyArchitectureGfxVisualToSource(
      renamedSource,
      renamedGroup.visualModel,
    );
    expect(renamedGroupSource).toContain(
      'group backend(server)["Core services"] in platform',
    );
    expect(renamedGroupSource).toContain("in backend");
  });

  test("projects semantic comment anchors without exposing parser identifiers", () => {
    const model = parseMermaidArchitectureSource(
      [
        "architecture-beta",
        "%% Title note",
        "title Platform architecture",
        '  group platform(cloud)["Platform"]',
        '  service gateway(server)["Gateway"] in platform',
        "  junction bus in platform",
        '  gateway:R -["HTTPS"]-> L:bus',
      ].join("\n"),
    )!;

    expect(architectureCommentAnchorLabel(model, model.comments![0])).toBe(
      "Platform architecture",
    );
    expect(
      architectureCommentAnchorLabel(model, {
        anchorId: "gateway",
        anchorKind: "service",
        id: "service-comment",
        line: "%% Service note",
        position: "after",
      }),
    ).toBe("Gateway");
    expect(
      architectureCommentAnchorLabel(model, {
        anchorId: model.edges[0].id,
        anchorKind: "edge",
        id: "edge-comment",
        line: "%% Edge note",
        position: "after",
      }),
    ).toBe("HTTPS");
  });

  test("fails layout explicitly without a server theme but keeps semantic source untouched", () => {
    vi.stubGlobal(
      "getComputedStyle",
      () => ({ getPropertyValue: () => "" }) as unknown as CSSStyleDeclaration,
    );
    const model = parseMermaidArchitectureSource(SOURCE)!;

    expect(() => layoutArchitectureGfxModel(model)).toThrow(
      MermaidGfxThemeUnavailableError,
    );
    expect(generateMermaidArchitectureSource(model)).toBe(SOURCE);
  });

  test("registers Architecture as its own runtime owner", () => {
    installProjectedTheme();
    expect(mermaidArchitectureFamily.id).toBe("architecture");
    expect(mermaidArchitectureFamily.diagramTypes).toEqual(["architecture"]);
    expect(mermaidRequirementFamily.diagramTypes).not.toContain("architecture");
    expect(getMermaidFamilyRuntime("architecture")?.id).toBe("architecture");
    const configured = architectureModelToGfxVisualModel(
      parseMermaidArchitectureSource(SOURCE)!,
    );
    expect(configured.nodes[0]).toBeDefined();
    expect(configured.edges[0]).toBeDefined();
    const projectedFontSize = resolveMermaidGfxTheme().typography.fontSize;
    expect(
      mermaidArchitectureGfxHookRegistration.hooks.nodeElementProjection(
        configured,
        configured.nodes[0]!,
      ).fontSize,
    ).toBe(projectedFontSize);
    expect(
      mermaidArchitectureGfxHookRegistration.hooks.edgeElementProjection(
        configured,
        configured.edges[0]!,
        0,
      ).fontSize,
    ).toBe(projectedFontSize);
    expect(mermaidArchitectureFamily.commands.map(({ id }) => id)).toEqual(
      expect.arrayContaining([
        "architecture.service.create",
        "architecture.relationship.create",
        "architecture.service.reparent",
        "architecture.align.row",
        "architecture.comment.create",
        "architecture.object.delete",
      ]),
    );
  });
});
