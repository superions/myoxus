import { c4ProjectionSelectionId } from "../families/c4/gfx-data.js";
import { layoutMeasuredFlowchart } from "../families/flowchart/layout.js";
import { getMermaidGfxNode, getMermaidGfxConnector } from "../commands.js";
import {
  Bound,
  ConnectorMode,
  DEFAULT_MERMAID_FLOWCHART_SOURCE,
  MermaidBlockComponent,
  addMermaidGfxEdgeCommand,
  addMermaidVisualNode,
  applyMermaidGfxEdgeCommand,
  applyMermaidGfxNodeCommand,
  applyMermaidGfxSubgraphCommand,
  applyArchitectureSemanticFieldMutations,
  applyMermaidVisualModelCommand,
  codeBlockMarkdownAdapterMatcher,
  connectMermaidVisualNodes,
  createDefaultMermaidVisualModel,
  createMermaidElementIndexMaps,
  createMermaidGfxCommandFixture,
  createMermaidVisualModelFromGfxElements,
  deleteMermaidVisualSelection,
  describe,
  ensureMermaidProjectionOwnerCommand,
  expect,
  expectMermaidVisualHash,
  generateMermaidSourceFromGfxVisualModel,
  generateMermaidSourceFromVisualModel,
  getMermaidVisualModelForEditing,
  hashMermaidSource,
  architectureEdgeFamilyData,
  architectureEdgeGfxData,
  architectureNodeFamilyData,
  architectureNodeGfxData,
  installProjectedMermaidTestTheme,
  isMermaidMarkdownCodeNode,
  mermaidBlockMarkdownAdapterMatcher,
  normalizeMermaidSourceInput,
  parseMermaidGanttSource,
  parseMermaidSourceToGfxVisualModel,
  parseMermaidSourceToVisualModel,
  parseMermaidTimelineSource,
  reconnectMermaidGfxEdgeCommand,
  reconnectMermaidVisualEdge,
  renameMermaidVisualEdge,
  resizeMermaidVisualNode,
  resolveMermaidConnectorLabelXYWH,
  setMermaidVisualEdgeLinkType,
  setMermaidVisualEdgeStyle,
  setMermaidVisualNodeShape,
  syncMermaidVisualModelFromProjectionOwnerCommand,
  test,
  toMermaidConnectorElementProps,
  toMermaidShapeElementProps,
  typeOwnedMermaidEdgeElementProjection,
  typeOwnedMermaidNodeElementProjection,
  type MermaidVisualModel,
} from "./mermaid-test-support.js";
import { createMindmapCommandConsumer } from "../families/mindmap/host-adapter.js";
import { afterEach, onTestFinished, vi } from "vitest";

import { MermaidGfxViewportBridge } from "../mermaid-gfx-viewport-bridge.js";
import {
  ConnectorPathGenerator,
  connector as paintConnector,
  connectorBaseDomRenderer,
} from "@virgultum/gfx-connector";
import { PointLocation } from "@virgultum/global/gfx";
import { LocalShapeElementModel } from "@virgultum/model";
import { previewMermaidGfxModel } from "../families/runtime/gfx-preview.js";
import {
  GfxPrimitiveElementModel,
  type GfxLocalElementModel,
  compareLayer,
  LayerManager,
  gfxGroupCompatibleSymbol,
  type GfxController,
} from "@virgultum/std/gfx";
import {
  readMermaidVisualModelFromProjectionGroup,
  preserveMermaidProjectionOwnerGeometry,
  resolveMermaidProjectionOwnerBoundForVisualModel,
} from "../commands/materialization.js";
import { getMermaidVisualModel } from "../commands/model-resolution.js";

import { preserveGitGraphOwnerTransform } from "../families/gitgraph/source-application.js";
import { MERMAID_GFX_TITLE_ROLE } from "../families/runtime/gfx-element-roles.js";
import {
  parseMermaidArchitectureSource,
  updateMermaidArchitectureDiagram,
} from "../engine/architecture/index.js";
import { architectureModelToGfxVisualModel } from "../families/architecture/visual-model.js";
import { reconcileArchitectureVisualProjection } from "../families/architecture/visual-reconciliation.js";
import {
  classProjectionBinding,
  classEdgeFamilyData,
  classEdgeGfxData,
} from "../families/class/gfx-data.js";
import { reparentTypeOwnedMermaidGfxNodes } from "../families/runtime/gfx-graph-operations.js";

import { getMermaidVisualNodeDetailElementEntries } from "../families/runtime/gfx-element-projection.js";
import { serializeMermaidVisualFamilyData } from "../families/runtime/gfx-family-data.js";
import {
  sequenceObjectFamilyData as sequenceEdgeFamilyData,
  sequenceFamilyPayload as sequenceEdgeGfxData,
  sequenceNodeFamilyData,
  sequenceNodeBinding as sequenceNodeGfxData,
  sequenceObjectFamilyData as sequenceSubgraphFamilyData,
} from "../families/sequence/gfx-data.js";
import { stateProjectionBinding } from "../families/state/gfx-data.js";
import { createStateCommandConsumer } from "../families/state/host-adapter.js";
import { prepareMermaidFamilySource } from "../families/runtime/registry.js";
import { createBlockCommandConsumer } from "../families/block/host-adapter.js";
import { readBlockProjectionModel } from "../families/block/source-application.js";
import {
  c4EdgeFamilyData,
  c4EdgeGfxData,
  c4NodeFamilyData,
  c4NodeGfxData,
} from "../families/c4/object-data.js";
import {
  gitGraphBinding,
  readGitGraphProjectionModel,
} from "../families/gitgraph/gfx-data.js";

import { editGitGraphCommit } from "../engine/gitgraph/commands/commit-commands.js";
import { gitGraphModelToVisual } from "../families/gitgraph/visual-model.js";
import { requirementEdgeFamilyData } from "../families/requirement/gfx-data.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Mermaid runtime integration contracts", () => {
  test("paints rounded routed corners in Canvas and SVG without moving the endpoints", () => {
    const paths: string[] = [];
    const originalPath = Object.getOwnPropertyDescriptor(globalThis, "Path2D");
    onTestFinished(() => {
      if (originalPath)
        Object.defineProperty(globalThis, "Path2D", originalPath);
      else Reflect.deleteProperty(globalThis, "Path2D");
    });
    vi.stubGlobal(
      "Path2D",
      class {
        constructor(readonly path: string) {
          paths.push(path);
        }
      },
    );
    const stroke = vi.fn();
    const ctx = {
      setTransform: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      stroke,
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
    };
    const model = {
      mode: ConnectorMode.Orthogonal,
      routingCornerRadius: 8,
      path: [
        [0, 0],
        [100, 0],
        [100, 100],
        [200, 100],
      ].map((p) => new PointLocation(p as [number, number])),
      stroke: "currentColor",
      strokeStyle: "solid",
      strokeWidth: 2,
      rough: false,
      frontEndpointStyle: "None",
      rearEndpointStyle: "None",
      w: 200,
      h: 100,
    };
    const renderer = {
      viewport: { zoom: 1 },
      getColorValue: (value: string) => value,
    };
    paintConnector(
      model as never,
      ctx as never,
      {} as DOMMatrix,
      renderer as never,
      {} as never,
      {} as never,
    );
    expect(stroke).toHaveBeenCalledWith(
      expect.objectContaining({
        path: expect.stringContaining("Q100,0 100,8"),
      }),
    );
    expect(paths[0]).toMatch(/^M0,0.*L200,100$/);
    const element = document.createElement("div");
    connectorBaseDomRenderer(model as never, element, renderer as never);
    const path = element.querySelector("svg > path")!.getAttribute("d")!;
    expect(path).toContain("Q120,20 120,28");
    expect(path).toMatch(/^M20,20.*L220,120$/);
  });

  test("cold GitGraph projection preserves whole-owner resize without reusing geometry for changed Source", () => {
    const source =
      'gitGraph\ncommit id:"A" msg:"Native history checkpoint"\nbranch feature\ncommit id:"B"\n';
    const fixture = createMermaidGfxCommandFixture(source);
    fixture.owner.props.title.delete(0, fixture.owner.props.title.length);
    const original = Bound.deserialize(fixture.owner.xywh);
    const scaled = new Bound(
      original.x,
      original.y,
      original.w * 1.3,
      original.h * 1.3,
    );
    fixture.owner.xywh = scaled.serialize();
    for (const element of fixture.elements.values()) {
      const metadata = element.yMap as {
        get(key: string): unknown;
        set(key: string, value: unknown): void;
      };
      if (metadata.get("mermaidNodeLabel") === "Native history checkpoint")
        metadata.set("mermaidNodeDisplayLabel", "Native\nhistory\ncheckpoint");
      if (metadata.get("mermaidNodeDisplayLabel") === "") {
        // Cold models have the Shape default before local appearance hydrates.
        element.textDisplay = true;
      }
      if (typeof element.xywh !== "string") continue;
      const b = Bound.deserialize(element.xywh);
      element.xywh = new Bound(
        original.x + (b.x - original.x) * 1.3,
        original.y + (b.y - original.y) * 1.3,
        b.w * 1.3,
        b.h * 1.3,
      ).serialize();
    }
    const cold = readMermaidVisualModelFromProjectionGroup(
      fixture.std.store,
      fixture.owner,
      getMermaidVisualModel(fixture.owner),
      "gitGraph",
    )!;
    expect(
      cold.nodes.find((n) => gitGraphBinding(n)?.role === "commit")!.label,
    ).toBe("A");
    expect(
      cold.nodes.find((n) => gitGraphBinding(n)?.role === "id")!.rotate,
    ).toBe(-45);
    const projected = preserveMermaidProjectionOwnerGeometry(
      fixture.std.store,
      fixture.owner,
      getMermaidVisualModel(fixture.owner)!,
    );
    expect(
      projected.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height]),
    ).toEqual(cold.nodes.map((n) => [n.id, n.x, n.y, n.width, n.height]));
    expect(
      resolveMermaidProjectionOwnerBoundForVisualModel(
        fixture.owner,
        projected,
        cold,
      ).serialize(),
    ).toBe(scaled.serialize());
    expect(fixture.source()).toBe(source);
    const branch = projected.nodes.find((n) => n.id.endsWith(":branch"))!;
    const oldBranch = fixture.elements.get(`shape-${branch.id}`)!;
    (oldBranch.yMap as { set(key: string, value: unknown): void }).set(
      "mermaidNodeShape",
      "text",
    );
    const upgraded = preserveMermaidProjectionOwnerGeometry(
      fixture.std.store,
      fixture.owner,
      getMermaidVisualModel(fixture.owner)!,
    );
    expect(
      upgraded.nodes.find((n) => gitGraphBinding(n)?.role === "commit")!.width,
    ).toBeCloseTo(26);
    const changed = editGitGraphCommit(
      readGitGraphProjectionModel(source, cold)!,
      gitGraphBinding(projected.nodes.find((n) => n.label === "A")!)!.sourceKey,
      { message: "Changed" },
    );
    const fresh = gitGraphModelToVisual(changed.model);
    const replayed = preserveMermaidProjectionOwnerGeometry(
      fixture.std.store,
      fixture.owner,
      fresh,
    );
    expect(
      replayed.nodes.find((n) => gitGraphBinding(n)?.role === "commit")!.width,
    ).toBe(20);
    const transformed = preserveGitGraphOwnerTransform(
      fresh,
      gitGraphModelToVisual(readGitGraphProjectionModel(source, cold)!),
      cold,
    );
    const childIds = [...fixture.childIds];
    applyMermaidVisualModelCommand(
      {
        std: fixture.std,
        model: fixture.owner,
        visualModel: transformed,
        sourceWrite: { baseSource: source, source: changed.source },
      } as never,
      () => undefined,
    );
    expect(fixture.source()).toBe(changed.source);
    expect(
      fixture.childIds.filter((id) => {
        const metadata = fixture.elements.get(id)!.yMap as {
          get(key: string): unknown;
        };
        return metadata.get("mermaidRole") !== MERMAID_GFX_TITLE_ROLE;
      }),
    ).toEqual(childIds);
    const edited = readMermaidVisualModelFromProjectionGroup(
      fixture.std.store,
      fixture.owner,
      getMermaidVisualModel(fixture.owner),
    )!;
    expect(
      edited.nodes.find((n) => gitGraphBinding(n)?.role === "commit")!.width,
    ).toBeCloseTo(26);
  });

  test("explicit Auto fits the full owner below the family's readable initial zoom", () => {
    const fixture = createMermaidGfxCommandFixture(
      "mindmap\nroot((Root))\n  Child\n",
    );
    const root = document.createElement("div");
    const viewport = {
      width: 320,
      height: 240,
      zoom: 1,
      centerX: 0,
      centerY: 0,
      setViewport: vi.fn(),
      setViewportByBound: vi.fn(() => {
        viewport.zoom = 0.25;
      }),
    };
    const bridge = new MermaidGfxViewportBridge({
      getModel: () => fixture.owner,
      getViewportSafeInsetBottom: () => 0,
      getRenderRoot: () => root,
      getElement: () => root,
    } as never);
    vi.spyOn(bridge, "getController").mockReturnValue({ viewport });
    bridge.fitViewport();
    expect(viewport.setViewport.mock.calls[0]?.[0]).toBe(1);
    expect(bridge.applyPageZoom("auto", { type: "center" })).toBe(0.25);
    const reconcile = vi.fn();
    const refresh = (
      MermaidBlockComponent.prototype as unknown as {
        _refreshPageGfxViewport: () => void;
      }
    )._refreshPageGfxViewport;
    refresh.call({
      _pageViewportState: { zoom: "auto" },
      _scopedGfxViewportUserPositioned: true,
      _gfxViewportBridge: bridge,
      _reconcileScopedGfxSelectionViewport: reconcile,
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(viewport.setViewportByBound).toHaveBeenCalledExactlyOnceWith(
      Bound.deserialize(fixture.owner.xywh),
      [36, 36, 36, 36],
    );
  });

  test("reveals stable record and compartment anchors in Page and scaled Notes", () => {
    for (const [viewScale, width, height] of [
      [1, 823, 544],
      [0.23, 181, 402],
    ]) {
      const node = { xywh: "[10,57,302,447]" };
      const row = {
        xywh: "[25,900,179,36]",
        mermaidDetailId: "detail-1",
        mermaidDetailSourceKey: "attribute-1",
      };
      const viewport = {
        centerX: -100 + width / 2,
        centerY: -137 + height / 2,
        height,
        viewScale,
        viewportX: -100,
        viewportY: -137,
        width,
        zoom: 1,
        toViewCoord(x: number, y: number): [number, number] {
          return [
            (x - this.viewportX) * viewScale,
            (y - this.viewportY) * viewScale,
          ];
        },
        setViewport(zoom: number, center?: [number, number]) {
          this.zoom = zoom;
          if (center) [this.centerX, this.centerY] = center;
          this.viewportX = this.centerX - width / zoom / 2;
          this.viewportY = this.centerY - height / zoom / 2;
        },
      };
      const root = document.createElement("div");
      const bridge = new MermaidGfxViewportBridge({
        getModel: () => ({ props: { source: "" } }),
        getViewportSafeInsetBottom: () => 0,
        getRenderRoot: () => root,
        getElement: () => root,
      } as never);
      vi.spyOn(bridge, "getController").mockReturnValue({ viewport });
      vi.spyOn(bridge, "getNodeModel").mockReturnValue(node as never);
      vi.spyOn(bridge, "getNodeDetailModels").mockReturnValue([row] as never);
      const physicalAnchor = (xywh: string) => {
        const rect = bridge.getModelViewRect(xywh)!;
        return [(rect.left + rect.width) * viewScale, rect.top * viewScale];
      };
      const expectVisible = (xywh: string) => {
        const [x, y] = physicalAnchor(xywh);
        expect(x).toBeGreaterThanOrEqual(36);
        expect(x).toBeLessThanOrEqual(width - 36);
        expect(y).toBeGreaterThanOrEqual(36);
        expect(y).toBeLessThanOrEqual(height - 36);
      };
      bridge.ensureNodeVisible("entity-1");
      expectVisible(node.xywh);
      const nodeAnchor = physicalAnchor(node.xywh);
      bridge.ensureNodeVisible("entity-1");
      expect(physicalAnchor(node.xywh)).toEqual(nodeAnchor);
      const host = {
        _gfxViewportBridge: bridge,
        _resolveDetailVisibilityTarget: () => ({
          ownerId: "entity-1",
          detailId: "attribute-1",
        }),
        _visualSelectionAnchorKey: (kind: string) =>
          kind === "node" ? "entity-1" : "",
      };
      const reveal = (
        MermaidBlockComponent.prototype as unknown as {
          _ensureScopedGfxSelectionVisible: () => void;
        }
      )._ensureScopedGfxSelectionVisible;
      reveal.call(host);
      expectVisible(row.xywh);
      const rowAnchor = physicalAnchor(row.xywh);
      reveal.call(host);
      expect(physicalAnchor(row.xywh)).toEqual(rowAnchor);
      expect(node.xywh).toBe("[10,57,302,447]");
      expect(row.xywh).toBe("[25,900,179,36]");
    }
  });

  test("reveals a temporal heading within the physical desktop excerpt and embedded action inset", () => {
    installProjectedMermaidTestTheme();
    const source =
      "sequenceDiagram\nparticipant A\nloop Retry\nA->>A: Poll\nend\n";
    const visual = parseMermaidSourceToGfxVisualModel(source).model!;
    const heading = visual.nodes.find(
      (node) => sequenceNodeGfxData(node)?.role === "branch",
    )!;
    const element = document.createElement("div");
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      left: 200,
      top: 200,
      right: 800,
      bottom: window.innerHeight + 700,
      width: 600,
      height: window.innerHeight + 500,
    } as DOMRect);
    const viewport = {
      width: 1000,
      height: 1900,
      viewScale: 0.65,
      zoom: 1,
      viewportX: 0,
      viewportY: 0,
      centerX: 500,
      centerY: 950,
      toViewCoord(x: number, y: number) {
        return [
          (x - this.viewportX) * this.viewScale,
          (y - this.viewportY) * this.viewScale,
        ];
      },
      setViewport(zoom: number, center: [number, number]) {
        this.zoom = zoom;
        [this.centerX, this.centerY] = center;
        this.viewportX = this.centerX - this.width / 2;
        this.viewportY = this.centerY - this.height / 2;
      },
    };
    const bridge = new MermaidGfxViewportBridge({
      getModel: () => ({ props: { source, diagramType: "sequenceDiagram" } }),
      getViewportSafeInsetBottom: () => 48,
      getRenderRoot: () => element,
      getElement: () => element,
    } as never);
    vi.spyOn(bridge, "getViewportElement").mockReturnValue(element);
    vi.spyOn(bridge, "getController").mockReturnValue({ viewport } as never);
    const xywh = "[10,1700,1500,31]";
    vi.spyOn(bridge, "getNodeModel").mockReturnValue({ xywh } as never);
    bridge.ensureNodeVisible(heading.id);
    // The Source heading begins at the left edge. Its far frame edge and the
    // Note's CSS-space height are not the available physical popup space.
    expect(10 - viewport.viewportX).toBeGreaterThanOrEqual(36);
    expect(10 - viewport.viewportX).toBeLessThanOrEqual(600 - 36);
    expect(1700 - viewport.viewportY).toBeLessThanOrEqual(
      window.innerHeight - 200 - 36 - 48,
    );
    const position = [viewport.viewportX, viewport.viewportY];
    bridge.ensureNodeVisible(heading.id);
    expect([viewport.viewportX, viewport.viewportY]).toEqual(position);
  });

  test("commits a complete Architecture layout configuration through the owner projection", () => {
    installProjectedMermaidTestTheme();
    const source = [
      "architecture-beta",
      "%% Architecture QA comment",
      "title Platform architecture",
      "accTitle: Platform system map",
      "accDescr: Nested services and event flow",
      'group platform(cloud)["Platform"]',
      'group core(server)["Core services"] in platform',
      'group data(database)["Data plane"] in platform',
      'service gateway(internet)["Gateway"] in core',
      'service application "API" ["Application service with a deliberately long label"] in core',
      'service worker(server)["Event worker"] in core',
      'service database(database)["Primary database"] in data',
      'service archive(disk)["Long-term archive"] in data',
      "junction bus in platform",
      'gateway:R -["HTTPS"]-> L:application',
      "application:R --> L:bus",
      "worker:B --> T:bus",
      'bus:R -["events"]-> L:database',
      "database:B --> T:archive",
      "align row gateway application worker",
      "align column application bus database archive",
    ].join("\n");
    const fixture = createMermaidGfxCommandFixture(source);
    const current = getMermaidVisualModelForEditing(
      fixture.std,
      fixture.mermaidBlock,
    )!;
    const parsed = parseMermaidArchitectureSource(source)!;
    const changed = updateMermaidArchitectureDiagram(parsed, {
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
    const requested = reconcileArchitectureVisualProjection(
      reprojected,
      current,
      { preserveGeometry: false },
    )!;
    expect(() =>
      generateMermaidSourceFromGfxVisualModel(source, requested),
    ).not.toThrow();
    let result: { applied: boolean; diagnostic?: string } | undefined;

    applyMermaidVisualModelCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
        visualModel: requested,
      } as never,
      (value) => {
        result = value;
      },
    );

    expect(result?.diagnostic).toBeUndefined();
    expect(result).toMatchObject({ applied: true });
    expect(fixture.source()).toContain('"randomize":true');
    expect(fixture.source()).toContain('"numIter":2000');
  });

  test("focuses a repaired record only after its replacement carrier renders", async () => {
    const carrier = document.createElement("button");
    carrier.className = "myoxus-mermaid-gfx-object-focus-proxy";
    carrier.dataset.mermaidEditKey = "repaired";
    const renderRoot = document.createElement("div");
    document.body.append(renderRoot);
    onTestFinished(() => renderRoot.remove());
    let complete!: () => void;
    const updateComplete = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const selection = {
      anchor: null as { editKey: string } | null,
      apply: vi.fn((_mode: string, items: { editKey: string }[]) => {
        selection.anchor = items.at(-1) ?? null;
      }),
    };
    const component = {
      _pendingVisualSelectionProjection: {
        items: [{ kind: "node", editKey: "repaired" }],
        focus: true,
      },
      _createVisualSelectionItem: () => ({
        kind: "node",
        editKey: "repaired",
        gfxElementId: "new-gfx",
      }),
      _visualSelection: selection,
      _gfxViewportBridge: { getViewportElement: () => renderRoot },
      _ensureScopedGfxSelectionVisible: vi.fn(),
      _restoreVisualObjectFocus: vi.fn(),
      renderRoot,
      updateComplete,
      requestUpdate: vi.fn(),
    };
    const reconcile = (
      MermaidBlockComponent.prototype as unknown as {
        _reconcileVisualSelectionProjection: () => void;
      }
    )._reconcileVisualSelectionProjection;
    reconcile.call(component);
    expect(component.requestUpdate).toHaveBeenCalled();
    expect(selection.apply).toHaveBeenCalledWith("replace", [
      { kind: "node", editKey: "repaired", gfxElementId: "new-gfx" },
    ]);
    expect(document.activeElement).not.toBe(carrier);
    renderRoot.append(carrier);
    complete();
    await updateComplete;
    expect(document.activeElement).toBe(carrier);
    // A newer selection must win while another render is pending.
    component._pendingVisualSelectionProjection = {
      items: [{ kind: "node", editKey: "repaired" }],
      focus: true,
    };
    reconcile.call(component);
    selection.anchor = { editKey: "another" };
    carrier.blur();
    await Promise.resolve();
    expect(document.activeElement).not.toBe(carrier);
  });

  test("selects an inserted node when its replacement GFX projection is ready", () => {
    const selectionApply = vi.fn();
    const restoreViewport = vi.fn();
    const remapVisualSelection = vi.fn();
    const prototype = MermaidBlockComponent.prototype as unknown as {
      _completePendingInsertedNodeProjection: () => boolean;
      _reconcileVisualSelectionProjection: () => void;
      _selectVisualNode: (nodeId: string, additive?: boolean) => boolean;
    };
    const component = {
      _createVisualSelectionItem: () => ({
        editKey: "N5",
        gfxElementId: "gfx-N5",
        kind: "node",
      }),
      _completePendingInsertedNodeProjection:
        prototype._completePendingInsertedNodeProjection,
      _gfxViewportBridge: {
        createFitKey: () => "ready-owner",
        restoreViewport,
      },
      _lastScopedGfxFitKey: "",
      _isInEdgelessMode: () => false,
      _pendingVisualInsertShape: null,
      _preservedScopedGfxViewport: { center: [10, 20], zoom: 1 },
      _preserveScopedGfxViewportForNodeId: "N5",
      _reconcileVisualSelectionProjection:
        prototype._reconcileVisualSelectionProjection,
      _remapVisualSelection: remapVisualSelection,
      _scheduleScopedGfxSelectionVisibility: vi.fn(),
      _selectVisualNode: prototype._selectVisualNode,
      _visualSelection: { apply: selectionApply },
      requestUpdate: vi.fn(),
    };

    (
      component._reconcileVisualSelectionProjection as unknown as () => void
    ).call(component);

    expect(selectionApply).toHaveBeenCalledExactlyOnceWith("replace", [
      { editKey: "N5", gfxElementId: "gfx-N5", kind: "node" },
    ]);
    expect(restoreViewport).toHaveBeenCalledExactlyOnceWith({
      center: [10, 20],
      zoom: 1,
    });
    expect(component._preserveScopedGfxViewportForNodeId).toBe("N5");
    expect(component._preservedScopedGfxViewport).toEqual({
      center: [10, 20],
      zoom: 1,
    });
    expect(component._lastScopedGfxFitKey).toBe("ready-owner");
    expect(remapVisualSelection).not.toHaveBeenCalled();
    expect(
      (
        component._completePendingInsertedNodeProjection as unknown as () => boolean
      ).call(component),
    ).toBe(true);
    expect(component._preserveScopedGfxViewportForNodeId).toBe("");
    expect(component._preservedScopedGfxViewport).toBeNull();
  });

  test("INV-MERMAID-IMPORT-01 creates mermaid snapshots from mermaid fences", async () => {
    const markdownNode = {
      type: "code",
      lang: "mermaid",
      value: "flowchart TD\n  A --> B",
    };
    const snapshots: unknown[] = [];

    expect(isMermaidMarkdownCodeNode(markdownNode as never)).toBe(true);
    expect(
      codeBlockMarkdownAdapterMatcher.toMatch({ node: markdownNode } as never),
    ).toBe(false);

    await mermaidBlockMarkdownAdapterMatcher.toBlockSnapshot.enter!(
      { node: markdownNode } as never,
      {
        walkerContext: {
          openNode: (nextNode: unknown) => {
            snapshots.push(nextNode);
            return { closeNode: () => undefined };
          },
        },
      } as never,
    );

    expect(snapshots).toMatchObject([
      {
        flavour: "myoxus:mermaid",
        props: {
          diagramType: "flowchart",
          source: {
            delta: [
              {
                insert: '---\ntitle: "Flowchart"\n---\nflowchart TD\n  A --> B',
              },
            ],
          },
        },
      },
    ]);
  });

  test("routes visual canvas undo and redo shortcuts through the document store", () => {
    const calls: string[] = [];
    const component = {
      _hydrateVisualSelectionFromScopedGfxSelection: () => false,
      contains: () => false,
      _isInEdgelessMode: () => false,
      _visualSelection: { items: [] },
      _getMermaidVisualModelForEditing: () => null,
      _getEditableEventTarget: (
        MermaidBlockComponent.prototype as unknown as {
          _getEditableEventTarget: (event: Event) => HTMLElement | null;
        }
      )._getEditableEventTarget,
      _getShellMode: () => "visual",
      _isPageVisualWorkareaKeyboardTarget: () => true,
      _isActiveEmbeddedGfxEditor: () => false,
      _pageSelectionEnabled: false,
      _handleRedo: () => calls.push("redo"),
      _handleUndo: () => calls.push("undo"),
      _replayVisualRedoFallback: () => false,
      _replayVisualUndoFallback: () => false,
      model: {
        props: {
          source: "",
        },
      },
      store: {
        canRedo: true,
        canUndo: true,
        redo: () => calls.push("redo"),
        undo: () => calls.push("undo"),
      },
    };
    const handler = (
      MermaidBlockComponent.prototype as unknown as {
        _handleBlockKeydown: (event: KeyboardEvent) => void;
      }
    )._handleBlockKeydown.bind(component);

    const undoEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "z",
    });
    handler(undoEvent);
    expect(undoEvent.defaultPrevented).toBe(true);

    const redoEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "z",
      shiftKey: true,
    });
    handler(redoEvent);
    const windowsRedoEvent = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      key: "y",
    });
    handler(windowsRedoEvent);

    expect(calls).toEqual(["undo", "redo", "redo"]);
  });

  test("hydrates scoped GFX selection before keyboard delete uses stale visual state", () => {
    const calls: string[] = [];
    const component = {
      contains: () => false,
      _isInEdgelessMode: () => false,
      _visualSelection: { items: [] },
      _getMermaidVisualModelForEditing: () => null,
      _getEditableEventTarget: () => null,
      _handlePageSelectionAction: () => false,
      _hasFamilySelectionAction: () => false,
      _handleDeleteVisualSelection: () => {
        calls.push(
          `delete:${component._selectedVisualNodeId}:${component._selectedVisualEdgeId}`,
        );
      },
      _hydrateVisualSelectionFromScopedGfxSelection: () => {
        calls.push("hydrate");
        component._selectedVisualEdgeId = "";
        component._selectedVisualNodeId = "B";
        return true;
      },
      _getShellMode: () => "visual",
      _isPageVisualWorkareaKeyboardTarget: () => true,
      _isActiveEmbeddedGfxEditor: () => false,
      _mode: "visual",
      _pageSelectionEnabled: false,
      _selectedVisualEdgeId: "stale-edge",
      _selectedVisualNodeId: "",
      _selectedVisualSubgraphId: "",
      store: { readonly: false },
    };
    const handler = (
      MermaidBlockComponent.prototype as unknown as {
        _handleBlockKeydown: (event: KeyboardEvent) => void;
      }
    )._handleBlockKeydown.bind(component);

    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Backspace",
    });
    handler(event);

    expect(event.defaultPrevented).toBe(true);
    expect(calls[0]).toBe("hydrate");
    expect(calls.at(-1)).toBe("delete:B:");
  });

  test("preserves native Tab traversal inside the scoped Page workarea", () => {
    const component = {
      _hydrateVisualSelectionFromScopedGfxSelection: () => false,
      contains: () => false,
      _isInEdgelessMode: () => false,
      _visualSelection: { items: [] },
      _getMermaidVisualModelForEditing: () => null,
      _getEditableEventTarget: () => null,
      _isPageVisualWorkareaKeyboardTarget: () => true,
      _isActiveEmbeddedGfxEditor: () => false,
      _pageSelectionEnabled: true,
    };
    const handler = (
      MermaidBlockComponent.prototype as unknown as {
        _handleBlockKeydown: (event: KeyboardEvent) => void;
      }
    )._handleBlockKeydown.bind(component);
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Tab",
    });

    handler(event);

    expect(event.cancelBubble).toBe(true);
    expect(event.defaultPrevented).toBe(false);
  });

  test("preserves explicit node labels when later edges reference the same id", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start] --> B{Decision}\n  B -->|Yes| C[Done]\n  B -->|No| D[Retry]\n",
    );
    const model = addMermaidVisualNode(parsed.model!);
    const source = generateMermaidSourceFromVisualModel(model);

    expect(source).toContain("B{Decision}");
    expect(source).not.toContain("B[B]");
  });

  test("adds visual flowchart nodes from semantic palette shapes", () => {
    const parsed = parseMermaidSourceToVisualModel("flowchart TD\n  A[Start]");
    const decisionModel = addMermaidVisualNode(parsed.model!, "diamond");
    const documentModel = addMermaidVisualNode(decisionModel, "doc", {
      centerX: 320,
      centerY: 240,
    });
    const source = generateMermaidSourceFromVisualModel(documentModel);

    expect(decisionModel.nodes.at(-1)).toMatchObject({
      label: "Decision 2",
      shape: "diamond",
    });
    const documentNode = documentModel.nodes.at(-1)!;
    expect(documentNode).toMatchObject({
      label: "Document 3",
      shape: "doc",
    });
    expect({
      x: documentNode.x + documentNode.width / 2,
      y: documentNode.y + documentNode.height / 2,
    }).toEqual({ x: 320, y: 240 });
    expect(source).toContain("N2{Decision 2}");
    expect(source).toContain('N3@{ shape: doc, label: "Document 3" }');
  });

  test("parses text-label and chained flowchart links into editable visual edges", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart LR",
        "  A[Start] -- approve --> B[Review] -. reject .-> C[Retry]",
        "  C == escalate ==> D[Done]",
        "  D --x E[Stop]",
      ].join("\n"),
    );

    expect(parsed.model).not.toBeNull();
    expect(parsed.model?.edges).toMatchObject([
      {
        label: "approve",
        linkType: "arrow",
        source: "A",
        target: "B",
      },
      {
        label: "reject",
        linkType: "dotted",
        source: "B",
        target: "C",
      },
      {
        label: "escalate",
        linkType: "thick",
        source: "C",
        target: "D",
      },
      {
        label: "",
        linkType: "cross",
        source: "D",
        target: "E",
      },
    ]);
    const source = generateMermaidSourceFromVisualModel(parsed.model!);
    expect(source).toContain("A[Start] --> |approve| B[Review]");
    expect(source).toContain("B -.-> |reject| C[Retry]");
    expect(source).toContain("C ==> |escalate| D[Done]");
    expect(source).toContain("D --x E[Stop]");
  });

  test("keeps Mermaid expanded flowchart shape syntax editable without dropping shape semantics", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        '  A@{ shape: doc, label: "Invoice" } --> B@{ shape: notch-rect, label: "Card" }',
        "  B --> C@{ shape: bow-tie-rectangle, label: Stored }",
        '  D@{ shape: dbl-circ, label: "Stop" }',
        '  E@{ shape: horizontal-cylinder, label: "Disk" }',
      ].join("\n"),
    );

    expect(parsed.model).not.toBeNull();
    expect(parsed.model?.nodes).toMatchObject([
      { id: "A", label: "Invoice", shape: "doc" },
      { id: "B", label: "Card", shape: "notch-rect" },
      { id: "C", label: "Stored", shape: "bow-rect" },
      { id: "D", label: "Stop", shape: "doublecircle" },
      { id: "E", label: "Disk", shape: "h-cyl" },
    ]);
    const source = generateMermaidSourceFromVisualModel(parsed.model!);
    expect(source).toContain('A@{ shape: doc, label: "Invoice" }');
    expect(source).toContain('B@{ shape: notch-rect, label: "Card" }');
    expect(source).toContain('C@{ shape: bow-rect, label: "Stored" }');
    expect(source).toContain("D(((Stop)))");
    expect(source).toContain('E@{ shape: h-cyl, label: "Disk" }');
  });

  test("materializes supported Mermaid flowchart shape and style semantics into GFX props", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        '  A@{ shape: doc, label: "Invoice" } --> B@{ shape: database, label: "Store" }',
        '  B --> C@{ shape: tri, label: "Extract" }',
        "  X>Asymmetric]",
        "  classDef active fill:#eef2ff,stroke:#4f46e5,color:#111827;",
        "  class A active;",
        "  style B fill:#ecfdf5,stroke:#059669,color:#064e3b;",
        "  linkStyle 0 stroke:#4f46e5,stroke-width:3px,stroke-dasharray: 5 5;",
      ].join("\n"),
    );
    const model = parsed.model!;
    const ownerBound = new Bound(100, 200, 500, 400);

    expect(
      toMermaidShapeElementProps(
        model.nodes[0],
        ownerBound,
        model.direction,
        model.diagramTitle,
        typeOwnedMermaidNodeElementProjection(model, model.nodes[0]),
      ),
    ).toMatchObject({
      color: "#111827",
      fillColor: "#eef2ff",
      shapeType: "mermaid-doc",
      strokeColor: "#4f46e5",
      text: "Invoice",
    });
    expect(
      toMermaidShapeElementProps(
        model.nodes[1],
        ownerBound,
        model.direction,
        model.diagramTitle,
        typeOwnedMermaidNodeElementProjection(model, model.nodes[1]),
      ),
    ).toMatchObject({
      color: "#064e3b",
      fillColor: "#ecfdf5",
      shapeType: "mermaid-cylinder",
      strokeColor: "#059669",
      text: "Store",
    });
    expect(
      toMermaidShapeElementProps(
        model.nodes[2],
        ownerBound,
        model.direction,
        model.diagramTitle,
        typeOwnedMermaidNodeElementProjection(model, model.nodes[2]),
      ),
    ).toMatchObject({
      shapeType: "triangle",
      text: "Extract",
    });
    expect(
      toMermaidShapeElementProps(
        model.nodes[3],
        ownerBound,
        model.direction,
        model.diagramTitle,
        typeOwnedMermaidNodeElementProjection(model, model.nodes[3]),
      ),
    ).toMatchObject({
      shapeType: "mermaid-asymmetric",
      text: "Asymmetric",
    });
    const connector = toMermaidConnectorElementProps(
      model.edges[0],
      new Map([
        ["A", "shape-a"],
        ["B", "shape-b"],
      ]),
      undefined,
      typeOwnedMermaidEdgeElementProjection(model, model.edges[0], 0),
    );
    expect(connector).toMatchObject({
      stroke: "#4f46e5",
      strokeStyle: "dash",
      strokeWidth: 3,
    });
    expect(connector.labelStyle.fontSize).toBe(
      typeOwnedMermaidEdgeElementProjection(model, model.edges[0], 0).fontSize,
    );
  });

  test("keeps geometry-only helper anchors from leaking node ids as visible text", () => {
    expect(
      toMermaidShapeElementProps(
        {
          displayLabel: " ",
          height: 2,
          id: "quadrant-x-axis-start-anchor",
          label: " ",
          shape: "text",
          width: 2,
          x: 0,
          y: 0,
        },
        new Bound(0, 0, 100, 100),
      ),
    ).toMatchObject({
      mermaidNodeId: "quadrant-x-axis-start-anchor",
      mermaidNodeDisplayLabel: " ",
      mermaidNodeLabel: " ",
      text: " ",
      textDisplay: false,
    });
  });

  test("uses an unconnected editable scaffold for new visual flowcharts", () => {
    const parsed = parseMermaidSourceToVisualModel(
      DEFAULT_MERMAID_FLOWCHART_SOURCE,
    );

    expect(parsed.model?.nodes.map((node) => node.id)).toEqual(["A", "B", "C"]);
    expect(parsed.model?.edges).toHaveLength(0);
    expect(createDefaultMermaidVisualModel().edges).toHaveLength(0);
  });

  test("adds visual flowchart nodes without implicit hidden connectors", () => {
    const parsed = parseMermaidSourceToVisualModel("flowchart TD\n  A[Start]");
    const model = addMermaidVisualNode(parsed.model!);

    expect(model.nodes.map((node) => node.id)).toEqual(["A", "N2"]);
    expect(model.edges).toHaveLength(0);
    expect(generateMermaidSourceFromVisualModel(model)).not.toContain("-->");
  });

  test("keeps standalone flowchart nodes editable instead of dropping them", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Only node]\n  1Start[Numeric id]\n",
    );

    expect(parsed.model?.edges).toHaveLength(0);
    expect(parsed.model?.nodes.map((node) => node.id)).toEqual(["A", "1Start"]);
    expect(generateMermaidSourceFromVisualModel(parsed.model!)).toContain(
      "1Start[Numeric id]",
    );
  });

  test("keeps supported flowchart style statements on the visual path", () => {
    const parsed = parseMermaidSourceToVisualModel(
      [
        "flowchart TD",
        "  A[Start] --> B[Done]",
        "  classDef accent fill:#eef2ff,stroke:#4f46e5,color:#111827;",
        "  class A,B accent;",
      ].join("\n"),
    );

    expect(parsed.diagramType).toBe("flowchart");
    expect(parsed.model?.styleStatements).toEqual([
      "classDef accent fill:#eef2ff,stroke:#4f46e5,color:#111827;",
      "class A,B accent;",
    ]);
    expect(
      parseMermaidSourceToVisualModel(
        "flowchart TD\n  A[Start] --> B[Done]\n  classDef accent fill:#eef2ff,stroke:#4f46e5,color:#111827;\n",
      ).model?.styleStatements,
    ).toEqual(["classDef accent fill:#eef2ff,stroke:#4f46e5,color:#111827;"]);
  });

  test("creates owner projection GFX props with remapped connector endpoints", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start] -->|Review| B[Done]\n",
    );
    const model = parsed.model!;
    const ownerBound = new Bound(100, 200, 400, 300);
    const shape = toMermaidShapeElementProps(model.nodes[0], ownerBound);
    expect(shape).toMatchObject({
      shapeType: "rect",
      text: "Start",
    });
    expect(shape.xywh).toContain("100");
    const elementProjection = typeOwnedMermaidEdgeElementProjection(
      model,
      model.edges[0],
      0,
    );
    const labelXYWH = resolveMermaidConnectorLabelXYWH({
      edge: model.edges[0],
      elementProjection,
      ownerBound,
      visualModel: model,
    });

    const connector = toMermaidConnectorElementProps(
      model.edges[0],
      new Map([
        ["A", "shape-a"],
        ["B", "shape-b"],
      ]),
      labelXYWH,
      elementProjection,
    );
    expect(connector).toMatchObject({
      labelDisplay: true,
      labelStyle: { fontSize: elementProjection.fontSize },
      mermaidEdgeId: "edge-A-B-1",
      mermaidRole: "mermaid-flowchart-edge",
      mode: ConnectorMode.Orthogonal,
      source: { id: "shape-a" },
      target: { id: "shape-b" },
      text: "Review",
    });
    expect(connector.labelXYWH).toEqual(labelXYWH);
  });

  test("orders Mermaid owner indexes with editable node labels above connectors", () => {
    const model: MermaidVisualModel = {
      diagramType: "stateDiagram-v2",
      direction: "TD",
      edges: [
        {
          id: "edge-Draft-Review",
          label: "submit",
          linkType: "arrow",
          source: "Draft",
          style: "solid",
          target: "Review",
        },
      ],
      nodes: [
        {
          height: 76,
          id: "Draft",
          label: "Draft",
          shape: "rounded",
          width: 130,
          x: 0,
          y: 0,
        },
        {
          height: 76,
          id: "Review",
          label: "Review",
          shape: "rounded",
          width: 130,
          x: 0,
          y: 140,
        },
      ],
      styleStatements: [],
      subgraphs: [
        {
          height: 280,
          id: "ReviewFlow",
          nodeIds: ["Draft", "Review"],
          title: "Review flow",
          width: 260,
          x: -40,
          y: -40,
        },
      ],
      version: 1,
    };
    let next = 0;

    const indexes = createMermaidElementIndexMaps(model, () => `a${next++}`);

    expect(indexes.subgraphs.get("ReviewFlow")).toBe("a0");
    expect(indexes.connectors.get("edge-Draft-Review")).toBe("a1");
    expect(indexes.shapes.get("Draft")).toBe("a2");
    expect(indexes.shapes.get("Review")).toBe("a3");

    installProjectedMermaidTestTheme();
    // Reverse UUID order forces the canvas's equal-index tie-break to expose
    // any candidate that omits the persisted owner's semantic layer plan.
    let uuid = 1000;
    vi.spyOn(crypto, "randomUUID").mockImplementation(
      () => `00000000-0000-4000-8000-${String(uuid--).padStart(12, "0")}`,
    );
    const locals = new Set<GfxLocalElementModel>();
    const surface = {
      localElementModels: locals,
      addLocalElement: (item: GfxLocalElementModel) => locals.add(item),
      deleteLocalElement: (item: GfxLocalElementModel) => locals.delete(item),
      getElementById: () => null,
      getGroups: () => [],
    };
    const creator = Object.create(GfxPrimitiveElementModel.prototype, {
      id: { value: "owner" },
      index: { value: "a0" },
      groups: { value: [] },
    });
    const dispose = previewMermaidGfxModel(model, {
      surface: surface as never,
      creator,
      viewport: {},
      origin: new Bound(0, 0, 400, 400),
      elements: [],
      refresh: () => undefined,
    });
    const paintedText = [...locals]
      .sort(compareLayer)
      .map((item) =>
        item instanceof LocalShapeElementModel ? item.text : null,
      );
    expect(paintedText.indexOf("Review flow")).toBeGreaterThanOrEqual(0);
    expect(paintedText.indexOf("Review flow")).toBeLessThan(
      paintedText.indexOf("Draft"),
    );
    expect(paintedText.indexOf("Review flow")).toBeLessThan(
      paintedText.indexOf("Review"),
    );
    dispose();
    expect(locals.size).toBe(0);
  });

  test("renders nested backgrounds before members across equal-index owners", () => {
    // Exercise the consumed canvas layers, not just fractional index strings.
    // These immutable records represent fully resolved Surface ancestry.
    const element = (
      id: string,
      index: string,
      groups: GfxPrimitiveElementModel[] = [],
      children?: string[],
    ): GfxPrimitiveElementModel =>
      Object.create(GfxPrimitiveElementModel.prototype, {
        id: { value: id },
        index: { value: index },
        groups: { value: groups },
        ...(children
          ? {
              [gfxGroupCompatibleSymbol]: { value: true },
              childIds: { value: children },
            }
          : {}),
      });
    const ownerA = element(
      "owner-a",
      "a0",
      [],
      ["outer", "inner", "edge", "node"],
    );
    const ownerB = element("owner-b", "a0", [], ["other"]);
    const outer = element("outer", "a0", [ownerA], ["inner", "node"]);
    const inner = element("inner", "a1", [outer, ownerA], ["node"]);
    const edge = element("edge", "a2", [ownerA]);
    const node = element("node", "a3", [inner, outer, ownerA]);
    const other = element("other", "a0", [ownerB]);
    for (const elements of [
      [node, other, edge, inner, outer],
      [other, outer, node, edge, inner],
      [inner, node, other, outer, edge],
    ]) {
      const manager = new LayerManager({
        std: { store: { getAllModels: () => [ownerA, ownerB] } },
        surface: { elementModels: elements, localElementModels: [] },
      } as unknown as GfxController);
      expect(
        manager.canvasLayers.flatMap((layer) =>
          layer.elements.map((item) => item.id),
        ),
      ).toEqual(["outer", "inner", "node", "edge", "other"]);
    }
  });

  test("reconstructs Mermaid source model from owner GFX shape and connector edits", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    const previousModel = parsed.model!;
    const meta = (values: Record<string, unknown>) => ({
      get: (key: string) => values[key],
    });
    const model = createMermaidVisualModelFromGfxElements({
      diagramType: "flowchart",
      direction: "TD",
      elements: [
        {
          id: "shape-a",
          radius: 0.16,
          text: { toString: () => "Renamed start" },
          type: "shape",
          xywh: "[120,220,180,96]",
          yMap: meta({
            mermaidNodeId: "A",
            mermaidNodeShape: "rounded",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
        {
          id: "shape-b",
          shapeType: "diamond",
          text: { toString: () => "Approved?" },
          type: "shape",
          xywh: "[120,380,180,120]",
          yMap: meta({
            mermaidNodeId: "B",
            mermaidNodeShape: "diamond",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
        {
          id: "connector-a-b",
          source: { id: "shape-a" },
          strokeStyle: "dash",
          target: { id: "shape-b" },
          text: { toString: () => "check" },
          type: "connector",
          yMap: meta({
            mermaidEdgeId: "edge-A-B-1",
            mermaidEdgeStyle: "dotted",
            mermaidRole: "mermaid-flowchart-edge",
          }),
        },
      ],
      ownerBound: { x: 100, y: 200 } as never,
      previousModel,
    });

    expect(model).toMatchObject({
      edges: [
        {
          id: "edge-A-B-1",
          label: "check",
          source: "A",
          style: "dotted",
          target: "B",
        },
      ],
      nodes: [
        {
          id: "A",
          label: "Renamed start",
          shape: "rounded",
          x: 20,
          y: 20,
        },
        {
          id: "B",
          label: "Approved?",
          shape: "diamond",
          x: 20,
          y: 180,
        },
      ],
    });
    expect(generateMermaidSourceFromVisualModel(model!)).toContain(
      "A(Renamed start) -.-> |check| B{Approved?}",
    );
  });

  test("prefers native GFX shape replacement over stale Mermaid shape metadata", () => {
    const previousModel = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Review step]\n",
    ).model!;
    const model = createMermaidVisualModelFromGfxElements({
      diagramType: "flowchart",
      direction: "TD",
      elements: [
        {
          id: "shape-a",
          shapeType: "diamond",
          text: { toString: () => "Review step" },
          type: "shape",
          xywh: "[120,220,180,96]",
          yMap: {
            get: (key) =>
              ({
                mermaidNodeId: "A",
                mermaidNodeShape: "rect",
                mermaidRole: "mermaid-flowchart-node",
              })[key],
          },
        },
      ],
      ownerBound: { x: 100, y: 200 } as never,
      previousModel,
    });

    expect(model?.nodes[0]).toMatchObject({
      id: "A",
      label: "Review step",
      shape: "diamond",
    });
    expect(generateMermaidSourceFromVisualModel(model!)).toContain(
      "A{Review step}",
    );
  });

  test("preserves explicit empty State and Sequence display labels during owner readback", () => {
    const meta = (values: Record<string, unknown>) => ({
      get: (key: string) => values[key],
    });
    const terminalData = parseMermaidSourceToGfxVisualModel(
      "stateDiagram-v2\n[*] --> Review",
    ).model!.nodes.find(
      (n) => stateProjectionBinding(n)?.kind === "start",
    )!.familyData;
    const stateModel = createMermaidVisualModelFromGfxElements({
      diagramType: "stateDiagram-v2",
      direction: "TD",
      elements: [
        {
          id: "state-start",
          text: { toString: () => "Review::__start__" },
          textDisplay: false,
          type: "shape",
          xywh: "[120,220,24,24]",
          yMap: meta({
            mermaidNodeDisplayLabel: "",
            mermaidNodeFamilyData:
              serializeMermaidVisualFamilyData(terminalData),
            mermaidNodeId: "Review::__start__",
            mermaidNodeLabel: "Review::__start__",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
      ],
      ownerBound: { x: 100, y: 200 } as never,
      previousModel: {
        diagramType: "stateDiagram-v2",
        direction: "TD",
        edges: [],
        nodes: [
          {
            displayLabel: "",
            height: 24,
            id: "Review::__start__",
            label: "Review::__start__",
            shape: "circle",
            familyData: terminalData,
            width: 24,
            x: 20,
            y: 20,
          },
        ],
        styleStatements: [],
        subgraphs: [],
        version: 1,
      },
    });
    expect(stateModel?.nodes[0]?.displayLabel).toBe("");

    const sequenceModel = createMermaidVisualModelFromGfxElements({
      diagramType: "sequenceDiagram",
      direction: "LR",
      elements: [
        {
          id: "sequence-user",
          shapeType: "rect",
          text: { toString: () => "User" },
          type: "shape",
          xywh: "[140,240,120,64]",
          yMap: meta({
            mermaidNodeDisplayLabel: "User",
            mermaidNodeFamilyData: serializeMermaidVisualFamilyData(
              sequenceNodeFamilyData({
                participantId: "User",
                participantType: "participant",
                sourceKey: "User",
                role: "participant",
              }),
            ),
            mermaidNodeId: "User",
            mermaidNodeLabel: "User",
            mermaidRole: "mermaid-flowchart-node",
          }),
        },
        {
          id: "sequence-rect",
          shapeType: "rect",
          text: { toString: () => "Subgraph 2" },
          textDisplay: false,
          type: "shape",
          xywh: "[120,220,320,180]",
          yMap: meta({
            mermaidRole: "mermaid-flowchart-subgraph",
            mermaidSubgraphFamilyData: serializeMermaidVisualFamilyData(
              sequenceSubgraphFamilyData({ backgroundKind: "rect" }),
            ),
            mermaidSubgraphId: "background-rect-2",
            mermaidSubgraphTitle: "",
          }),
        },
      ],
      ownerBound: { x: 100, y: 200 } as never,
      previousModel: {
        diagramType: "sequenceDiagram",
        direction: "LR",
        edges: [],
        nodes: [
          {
            height: 64,
            id: "User",
            label: "User",
            shape: "rect",
            familyData: sequenceNodeFamilyData({
              participantId: "User",
              participantType: "participant",
              sourceKey: "User",
              role: "participant",
            }),
            width: 120,
            x: 40,
            y: 40,
          },
        ],
        styleStatements: [],
        subgraphs: [
          {
            height: 180,
            id: "background-rect-2",
            familyData: sequenceSubgraphFamilyData({
              backgroundKind: "rect",
            }),
            nodeIds: [],
            title: "",
            width: 320,
            x: 20,
            y: 20,
          },
        ],
        version: 1,
      },
    });
    expect(sequenceModel?.subgraphs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "background-rect-2",
          title: "",
        }),
      ]),
    );
  });

  test("mutates flowchart node labels and shapes directly on owner GFX elements", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    let payload: unknown = null;

    applyMermaidGfxNodeCommand(
      {
        label: "Reviewed start",
        model: fixture.mermaidBlock,
        nodeId: "A",
        shape: "rounded",
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const shapeA = fixture.elements.get("shape-A") as {
      text?: string;
      yMap?: { get: (key: string) => unknown };
    };
    expect(payload).toMatchObject({
      sourceHash: expect.stringMatching(/^fnv1a:/),
      visualModelHash: expect.stringMatching(/^fnv1a:/),
    });
    expect(shapeA.text).toBe("Reviewed start");
    expect(shapeA.yMap?.get("mermaidNodeShape")).toBe("rounded");
    expect(fixture.source()).toContain("A(Reviewed start)");
  });

  test("removes the exact non-final flowchart connector from owner GFX", () => {
    const fixture = createMermaidGfxCommandFixture(
      [
        "flowchart TD",
        "  A[Start] edge-A-B-1@--> B{Decision}",
        "  B edge-B-C-2@--> |Yes| C[Done]",
        "  B edge-B-D-3@--> |No| D[Retry]",
      ].join("\n"),
    );
    const current = getMermaidVisualModelForEditing(
      fixture.std,
      fixture.mermaidBlock,
    )!;
    const requested = deleteMermaidVisualSelection(current, {
      edgeId: "edge-B-C-2",
    });
    let applied = false;

    applyMermaidVisualModelCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
        visualModel: requested,
      } as never,
      (result) => {
        applied = result?.applied === true;
      },
    );

    expect(applied).toBe(true);
    expect(fixture.source()).not.toContain("edge-B-C-2@-->");
    expect(fixture.source()).toContain("edge-B-D-3@-->");
    expect(fixture.childIds).not.toContain("connector-2");
    expect(fixture.childIds).toContain("connector-3");
    expect(fixture.elements.has("connector-2")).toBe(false);
    const retainedConnector = fixture.elements.get("connector-3") as
      { yMap: { get: (key: string) => unknown } } | undefined;
    expect(String(retainedConnector?.yMap.get("mermaidEdgeId") ?? "")).toBe(
      "edge-B-D-3",
    );
  });

  test("keeps Gantt milestone semantics in the source model without GFX shapes", () => {
    const model = parseMermaidGanttSource(
      "gantt\n  section Work\n  Design :milestone, a1, 2026-01-01, 3d\n",
    )!;
    expect(model.tasks[0]?.isMilestone).toBe(true);
    expect(
      parseMermaidSourceToGfxVisualModel(model.sourceDocument.source).model,
    ).toBeNull();
  });

  test("writes flowchart node semantic style directly to owner GFX props and source", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );

    applyMermaidGfxNodeCommand(
      {
        model: fixture.mermaidBlock,
        nodeId: "A",
        std: fixture.std,
        styleClass: "accent",
      } as never,
      () => undefined,
    );

    const shapeA = fixture.elements.get("shape-A") as {
      fillColor?: string;
      strokeColor?: string;
      yMap?: { get: (key: string) => unknown };
    };
    expect(shapeA.fillColor).toBe("rgb(245, 245, 245)");
    expect(shapeA.strokeColor).toBe("rgb(70, 90, 210)");
    expect(shapeA.yMap?.get("mermaidNodeStyleClass")).toBe("accent");
    expect(fixture.source()).toContain(
      "classDef accent fill:rgb(245, 245, 245),stroke:rgb(70, 90, 210),color:rgb(20, 20, 20);",
    );
    expect(fixture.source()).toContain("class A accent;");
  });

  test("keeps direct flowchart node resize authoritative in owner GFX geometry", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    const shapeA = fixture.elements.get("shape-A") as {
      xywh?: string;
    };
    applyMermaidGfxNodeCommand(
      {
        height: 132,
        model: fixture.mermaidBlock,
        nodeId: "A",
        std: fixture.std,
        width: 240,
      } as never,
      () => undefined,
    );

    const resized = Bound.deserialize(String(shapeA.xywh));
    expect(resized.w).toBe(240);
    expect(resized.h).toBe(132);
  });

  test("writes flowchart edge semantic style directly to owner GFX props and source", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );

    applyMermaidGfxEdgeCommand(
      {
        edgeId: "edge-A-B-1",
        model: fixture.mermaidBlock,
        std: fixture.std,
        visualStyle: "success",
      } as never,
      () => undefined,
    );

    const connector = fixture.elements.get("connector-1") as {
      stroke?: string;
      yMap?: { get: (key: string) => unknown };
    };
    expect(connector.stroke).toBe("rgb(30, 130, 70)");
    expect(connector.yMap?.get("mermaidEdgeVisualStyle")).toBe("success");
    expect(fixture.source()).toContain(
      "linkStyle 0 stroke:rgb(30, 130, 70),stroke-width:2px;",
    );

    applyMermaidGfxEdgeCommand(
      {
        edgeId: "edge-A-B-1",
        model: fixture.mermaidBlock,
        std: fixture.std,
        style: "dotted",
      } as never,
      () => undefined,
    );

    expect(fixture.source()).toContain("A[Start] edge-A-B-1@-.-> B[Done]");
  });

  test("adds flowchart connectors directly as owner GFX connector children", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start]\n  B[Done]\n",
    );
    const foreignNode = {
      ...fixture.elements.get("shape-A")!,
      id: "other-diagram-A",
      groups: [{ id: "ordinary-frame" }],
    };
    const foreignOwner = {
      id: "other-diagram",
      childIds: [foreignNode.id],
    };
    Object.assign(fixture.owner.surface!, {
      elementModels: [...fixture.elements.values(), foreignNode],
    });
    const getBlocks = fixture.std.store.getBlocksByFlavour.bind(
      fixture.std.store,
    );
    vi.spyOn(fixture.std.store, "getBlocksByFlavour").mockImplementation(
      (flavour) =>
        flavour === "myoxus:mermaid"
          ? [...getBlocks(flavour), { model: foreignOwner } as never]
          : getBlocks(flavour),
    );
    let edgeId = "";

    addMermaidGfxEdgeCommand(
      {
        model: fixture.mermaidBlock,
        sourceNodeId: "A",
        std: fixture.std,
        targetNodeId: "B",
      } as never,
      (next: unknown) => {
        edgeId = (next as { edgeId?: string }).edgeId ?? "";
      },
    );

    const connector = [...fixture.elements.values()].find(
      (element) =>
        element.type === "connector" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidEdgeId",
        ) === edgeId,
    ) as
      | {
          id?: string;
          source?: { id?: string };
          target?: { id?: string };
          yMap?: { get: (key: string) => unknown };
        }
      | undefined;
    expect(edgeId).toBe("edge-A-B-1");
    expect(connector?.source?.id).toBe("shape-A");
    expect(connector?.target?.id).toBe("shape-B");
    expect(connector?.yMap?.get("mermaidEdgeLabelPlacement")).toBe("center");
    expect(fixture.childIds).toContain(String(connector?.id));
    expect(fixture.childIds).not.toContain(foreignNode.id);
    expect(foreignOwner.childIds).toEqual([foreignNode.id]);
    expect(fixture.source()).toContain("A[Start] edge-A-B-1@--> B[Done]");
  });

  test("keeps vertical Class cardinalities outside both member compartments", () => {
    const fixture = createMermaidGfxCommandFixture(
      'classDiagram\nclass User {\n  +id: UUID\n}\nclass Session\nUser "1" --> "*" Session : owns\n',
    );
    const visual = getMermaidVisualModelForEditing(
      fixture.std,
      fixture.mermaidBlock,
    )!;
    const annotations = getMermaidVisualNodeDetailElementEntries(visual).filter(
      (entry) => entry.detail.kind === "endpoint",
    );
    const source = visual.nodes.find((node) => node.label === "User")!;
    const target = visual.nodes.find((node) => node.label === "Session")!;
    const start = annotations.find((entry) => entry.detail.label === "1")!.node;
    const end = annotations.find((entry) => entry.detail.label === "*")!.node;
    expect(start.y).toBeGreaterThan(source.y + source.height);
    expect(end.y + end.height).toBeLessThan(target.y);
    expect(fixture.source()).toContain('User "1" --> "*" Session : owns');
  });

  test("keeps mixed Class and note movement geometric instead of filtering namespace membership", () => {
    const source =
      'classDiagram\nnamespace commerce {\n  class Order\n}\nclass Shipment\nnote for Shipment "Attached"\nnote "Audit"\n';
    const fixture = createMermaidGfxCommandFixture(source);
    const model = getMermaidVisualModelForEditing(
      fixture.std,
      fixture.mermaidBlock,
    )!;
    const shipment = model.nodes.find(
      (node) => classProjectionBinding(node)?.sourceId === "Shipment",
    )!;
    const note = model.nodes.find((node) => node.label === "Audit")!;
    const parentId = model.subgraphs![0].id;
    const moved = {
      ...model,
      nodes: model.nodes.map((node) =>
        [shipment.id, note.id].includes(node.id)
          ? { ...node, x: node.x + 20 }
          : node,
      ),
    };
    expect(
      reparentTypeOwnedMermaidGfxNodes(moved, [shipment.id, note.id], parentId),
    ).toBeNull();
    applyMermaidVisualModelCommand(
      {
        std: fixture.std,
        model: fixture.mermaidBlock,
        visualModel: moved,
      } as never,
      () => undefined,
    );
    expect(fixture.source()).toBe(source);
    const reparented = reparentTypeOwnedMermaidGfxNodes(
      moved,
      [shipment.id],
      parentId,
    )!;
    expect(reparented.subgraphs![0].nodeIds).toContain(shipment.id);
    applyMermaidVisualModelCommand(
      {
        std: fixture.std,
        model: fixture.mermaidBlock,
        visualModel: reparented,
      } as never,
      () => undefined,
    );
    expect(fixture.source()).toContain(
      "namespace commerce {\n  class Order\nclass Shipment\n}",
    );
    expect(fixture.source()).toContain('note "Audit"');
  });

  test("writes Relationship family GFX edge commands back to semantic Mermaid source", () => {
    const classSource =
      'classDiagram\r\n  class Document\r\n  class Diagram\r\n  class Export\r\n  Document "1" *-- "1..*" Diagram : renders\r\n  click Document call opaqueCallback "Keep callback"\r\n';
    const classFixture = createMermaidGfxCommandFixture(classSource);
    const classModel = getMermaidVisualModelForEditing(
      classFixture.std,
      classFixture.mermaidBlock,
    )!;
    const classEdgeId = classModel.edges[0].id;
    const classId = (sourceId: string) =>
      classModel.nodes.find(
        (node) => classProjectionBinding(node)?.sourceId === sourceId,
      )!.id;
    let addedEdgeId = "";

    applyMermaidGfxEdgeCommand(
      {
        edgeId: classEdgeId,
        familyData: classEdgeFamilyData({
          ...classEdgeGfxData(classModel.edges[0])!,
          relationKind: "..|>",
        }),
        label: "generalizes",
        model: classFixture.mermaidBlock,
        std: classFixture.std,
      } as never,
      () => undefined,
    );
    reconnectMermaidGfxEdgeCommand(
      {
        edgeId: classEdgeId,
        endpoint: "target",
        model: classFixture.mermaidBlock,
        nodeId: classId("Export"),
        std: classFixture.std,
      } as never,
      () => undefined,
    );
    expect(classFixture.source()).toBe(
      classSource.replace(
        'Document "1" *-- "1..*" Diagram : renders',
        'Document "1" ..|> "1..*" Export : generalizes',
      ),
    );
    reconnectMermaidGfxEdgeCommand(
      {
        edgeId: classEdgeId,
        endpoint: "target",
        model: classFixture.mermaidBlock,
        nodeId: classId("Document"),
        std: classFixture.std,
      } as never,
      () => undefined,
    );
    expect(classFixture.source()).toBe(
      classSource.replace(
        'Document "1" *-- "1..*" Diagram : renders',
        'Document "1" ..|> "1..*" Document : generalizes',
      ),
    );
    addMermaidGfxEdgeCommand(
      {
        model: classFixture.mermaidBlock,
        sourceNodeId: classId("Diagram"),
        std: classFixture.std,
        targetNodeId: classId("Export"),
      } as never,
      (next: unknown) => {
        addedEdgeId = (next as { edgeId?: string }).edgeId ?? "";
      },
    );

    expect(addedEdgeId).toBeTruthy();
    const addedConnector = [...classFixture.elements.values()].find(
      (element) =>
        element.type === "connector" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidEdgeId",
        ) === addedEdgeId,
    ) as { mode?: ConnectorMode; yMap?: { get: (key: string) => unknown } };
    expect(addedConnector.mode).toBe(ConnectorMode.Straight);
    expect(addedConnector.yMap?.get("mermaidEdgeLabelPlacement")).toBe("top");
    expect(classFixture.source()).toContain(
      'Document "1" ..|> "1..*" Document : generalizes',
    );
    expect(classFixture.source()).toContain("Diagram --> Export");

    const requirementFixture = createMermaidGfxCommandFixture(
      "requirementDiagram\n  requirement req1 {\n    id: 1\n    text: Export works\n  }\n  element doc1 {\n    type: document\n  }\n  element doc2 {\n    type: document\n  }\n  req1 - satisfies -> doc1\n",
    );
    const requirementModel = getMermaidVisualModelForEditing(
      requirementFixture.std,
      requirementFixture.mermaidBlock,
    )!;
    const requirementEdgeId = requirementModel.edges[0].id;

    applyMermaidGfxEdgeCommand(
      {
        edgeId: requirementEdgeId,
        familyData: requirementEdgeFamilyData({ relationKind: "verifies" }),
        model: requirementFixture.mermaidBlock,
        std: requirementFixture.std,
      } as never,
      () => undefined,
    );
    reconnectMermaidGfxEdgeCommand(
      {
        edgeId: requirementEdgeId,
        endpoint: "target",
        model: requirementFixture.mermaidBlock,
        nodeId: "doc2",
        std: requirementFixture.std,
      } as never,
      () => undefined,
    );

    expect(requirementFixture.source()).toContain("req1 - verifies -> doc2");
  });

  test("writes State/Sequence family GFX commands back to semantic Mermaid source", () => {
    const expectedSequenceModel = parseMermaidSourceToGfxVisualModel(
      "sequenceDiagram\n  participant User\n  actor API\n  participant Worker\n  User->>API: Request\n  API-->>User: Response\n",
    ).model!;
    const sequenceReadbackFixture = createMermaidGfxCommandFixture(
      "sequenceDiagram\n  participant User\n  actor API\n  participant Worker\n  User->>API: Request\n  API-->>User: Response\n",
    );
    const sequenceReadback = getMermaidVisualModelForEditing(
      sequenceReadbackFixture.std,
      sequenceReadbackFixture.mermaidBlock,
    )!;
    const comparableSequenceNodes = (nodes: MermaidVisualModel["nodes"]) =>
      nodes.map((node) => ({
        displayLabel: node.displayLabel ?? node.label,
        id: node.id,
        label: node.label,
        participantId: sequenceNodeGfxData(node)?.participantId,
        participantType: sequenceNodeGfxData(node)?.participantType,
        role: sequenceNodeGfxData(node)?.role,
        shape: node.shape,
      }));
    expect(comparableSequenceNodes(sequenceReadback.nodes)).toEqual(
      comparableSequenceNodes(expectedSequenceModel.nodes),
    );
    expect(
      sequenceReadback.edges.map((edge) => ({
        arrow: sequenceEdgeGfxData(edge)?.arrow,
        connectorMode: edge.connectorMode,
        id: edge.id,
        label: edge.label,
        linkType: edge.linkType,
        source: edge.source,
        target: edge.target,
      })),
    ).toEqual(
      expectedSequenceModel.edges.map((edge) => ({
        arrow: sequenceEdgeGfxData(edge)?.arrow,
        connectorMode: edge.connectorMode,
        id: edge.id,
        label: edge.label,
        linkType: edge.linkType,
        source: edge.source,
        target: edge.target,
      })),
    );
    expect(sequenceReadback.diagramType).toBe(
      expectedSequenceModel.diagramType,
    );

    const sequenceFixture = createMermaidGfxCommandFixture(
      "sequenceDiagram\n  participant User\n  participant API\n  participant Worker\n  User->>API: Request\n",
    );
    const sequenceModel = getMermaidVisualModelForEditing(
      sequenceFixture.std,
      sequenceFixture.mermaidBlock,
    )!;
    const sequenceEdgeId = sequenceModel.edges[0].id;
    expect(sequenceModel.edges[0]).toMatchObject({
      source: sequenceModel.nodes.find(
        (n) =>
          sequenceNodeGfxData(n)?.participantId === "User" &&
          sequenceNodeGfxData(n)?.role === "participant",
      )!.id,
      sourcePosition: [0.5, expect.any(Number)],
      target: sequenceModel.nodes.find(
        (n) =>
          sequenceNodeGfxData(n)?.participantId === "API" &&
          sequenceNodeGfxData(n)?.role === "participant",
      )!.id,
      targetPosition: [0.5, expect.any(Number)],
    });

    applyMermaidGfxNodeCommand(
      {
        familyData: sequenceNodeFamilyData({
          ...sequenceNodeGfxData(
            sequenceModel.nodes.find(
              (n) =>
                sequenceNodeGfxData(n)?.participantId === "API" &&
                sequenceNodeGfxData(n)?.role === "participant",
            )!,
          )!,
          participantType: "actor",
        }),
        label: "Service API",
        model: sequenceFixture.mermaidBlock,
        nodeId: sequenceModel.nodes.find(
          (n) =>
            sequenceNodeGfxData(n)?.participantId === "API" &&
            sequenceNodeGfxData(n)?.role === "participant",
        )!.id,
        std: sequenceFixture.std,
      } as never,
      () => undefined,
    );
    applyMermaidGfxEdgeCommand(
      {
        edgeId: sequenceEdgeId,
        familyData: sequenceEdgeFamilyData({
          ...sequenceEdgeGfxData(sequenceModel.edges[0]),
          arrow: "-->>",
        }),
        label: "Done",
        model: sequenceFixture.mermaidBlock,
        std: sequenceFixture.std,
      } as never,
      () => undefined,
    );
    reconnectMermaidGfxEdgeCommand(
      {
        edgeId: sequenceEdgeId,
        endpoint: "target",
        model: sequenceFixture.mermaidBlock,
        nodeId: sequenceModel.nodes.find(
          (n) =>
            sequenceNodeGfxData(n)?.participantId === "Worker" &&
            sequenceNodeGfxData(n)?.role === "participant",
        )!.id,
        std: sequenceFixture.std,
      } as never,
      () => undefined,
    );

    expect(sequenceFixture.source()).toContain(
      "participant API@{type: actor} as Service API",
    );
    expect(sequenceFixture.source()).toContain("User-->>Worker: Done");

    const stateFixture = createMermaidGfxCommandFixture(
      "stateDiagram-v2\n  Idle --> Busy : start\n  Busy --> Done : finish\n",
    );
    const stateModel = getMermaidVisualModelForEditing(
      stateFixture.std,
      stateFixture.mermaidBlock,
    )!;
    const stateEdgeId = stateModel.edges[0].id;

    applyMermaidGfxEdgeCommand(
      {
        edgeId: stateEdgeId,
        label: "finish",
        model: stateFixture.mermaidBlock,
        std: stateFixture.std,
      } as never,
      () => undefined,
    );
    reconnectMermaidGfxEdgeCommand(
      {
        edgeId: stateEdgeId,
        endpoint: "target",
        model: stateFixture.mermaidBlock,
        nodeId: stateModel.nodes.find(
          (n) => stateProjectionBinding(n)?.sourceId === "Done",
        )!.id,
        std: stateFixture.std,
      } as never,
      () => undefined,
    );

    expect(stateFixture.source()).toContain("Idle --> Done : finish");
    expect(stateFixture.source()).toMatch(/^stateDiagram-v2\n/);
  });

  test("writes GitGraph attributes only through the checked Source command and preserves occurrence identity", () => {
    const source = 'gitGraph\n  commit id:"Initial"\n';
    const fixture = createMermaidGfxCommandFixture(source);
    const current = getMermaidVisualModelForEditing(
      fixture.std,
      fixture.mermaidBlock,
    )!;
    const initialCommit = current.nodes.find(
      (n) => gitGraphBinding(n)?.role === "commit",
    )!;
    applyMermaidGfxNodeCommand(
      {
        label: "free edit",
        model: fixture.mermaidBlock,
        nodeId: initialCommit.id,
        std: fixture.std,
      } as never,
      () => undefined,
    );
    expect(fixture.source()).toBe(source);
    const model = readGitGraphProjectionModel(source, current)!;
    const changed = editGitGraphCommit(model, initialCommit.id, {
      message: "Reviewed",
      tags: ["v1.0"],
    });
    let result: { applied: boolean } | undefined;
    applyMermaidVisualModelCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
        visualModel: gitGraphModelToVisual(changed.model),
        sourceWrite: { baseSource: source, source: changed.source },
      } as never,
      (value) => {
        result = value;
      },
    );
    expect(result).toMatchObject({ applied: true });
    expect(fixture.source()).toContain(
      'commit id:"Initial" msg:"Reviewed" tag:"v1.0"',
    );
    expect(
      getMermaidVisualModelForEditing(
        fixture.std,
        fixture.mermaidBlock,
      )!.nodes.some((n) => n.id === initialCommit.id),
    ).toBe(true);
  });

  test("writes Architecture family GFX commands back to semantic Mermaid source", () => {
    installProjectedMermaidTestTheme();
    const architectureFixture = createMermaidGfxCommandFixture(
      'architecture-beta\n  group web(server)[Web]\n  service app(server)[App] in web\n  service db(database)[DB] in web\n  app:R -["reads"]-> L:db\n',
    );
    const architectureModel = getMermaidVisualModelForEditing(
      architectureFixture.std,
      architectureFixture.mermaidBlock,
    )!;
    const architectureEdge = architectureEdgeGfxData(
      architectureModel.edges[0],
    )!;
    applyMermaidGfxEdgeCommand(
      {
        edgeId: architectureModel.edges[0].id,
        familyData: architectureEdgeFamilyData({
          ...architectureEdge,
          fromPort: "B",
          toPort: "T",
        }),
        label: "queries",
        model: architectureFixture.mermaidBlock,
        sourcePosition: [0.5, 1],
        std: architectureFixture.std,
        targetPosition: [0.5, 0],
      } as never,
      () => undefined,
    );
    expect(architectureFixture.source()).toContain('app:B -["queries"]-> T:db');
    const architectureConnector = architectureFixture.elements.get(
      "connector-1",
    ) as {
      yMap?: { get: (key: string) => unknown };
    };
    expect(architectureConnector.yMap?.get("mermaidEdgeLabelPlacement")).toBe(
      "center",
    );
    applyMermaidGfxNodeCommand(
      {
        familyData: architectureNodeFamilyData({
          ...architectureNodeGfxData(
            architectureModel.nodes.find(({ id }) => id === "app")!,
          )!,
          hasIcon: true,
          icon: "database",
          iconKind: "icon",
        }),
        model: architectureFixture.mermaidBlock,
        nodeId: "app",
        std: architectureFixture.std,
      } as never,
      () => undefined,
    );
    expect(architectureFixture.source()).toContain(
      'service app(database)["App"] in web',
    );
    const architectureAfterNodeEdit = getMermaidVisualModelForEditing(
      architectureFixture.std,
      architectureFixture.mermaidBlock,
    )!;
    const architectureGroupIconMutation =
      applyArchitectureSemanticFieldMutations(
        parseMermaidArchitectureSource(architectureFixture.source())!,
        architectureAfterNodeEdit,
        { subgraphId: "web" },
        [{ control: "architectureGroupIcon", value: "cloud" }],
      );
    expect(architectureGroupIconMutation.changed).toBe(true);
    if (!architectureGroupIconMutation.changed) return;
    const architectureWithGroupIcon = architectureGroupIconMutation.visualModel;
    const updatedWebGroup = architectureWithGroupIcon.subgraphs!.find(
      ({ id }) => id === "web",
    )!;
    applyMermaidGfxSubgraphCommand(
      {
        familyData: updatedWebGroup.familyData,
        model: architectureFixture.mermaidBlock,
        std: architectureFixture.std,
        subgraphId: "web",
        title: updatedWebGroup.title,
      } as never,
      () => undefined,
    );
    expect(architectureFixture.source()).toContain('group web(cloud)["Web"]');
    const webGroupBefore = Bound.deserialize(
      String(architectureFixture.elements.get("subgraph-web")?.xywh),
    );
    const appNodeBefore = Bound.deserialize(
      String(architectureFixture.elements.get("shape-app")?.xywh),
    );
    applyMermaidGfxSubgraphCommand(
      {
        model: architectureFixture.mermaidBlock,
        moveMembers: true,
        std: architectureFixture.std,
        subgraphId: "web",
        x: architectureModel.subgraphs![0].x + 40,
        y: architectureModel.subgraphs![0].y + 24,
      } as never,
      () => undefined,
    );
    const webGroupAfter = Bound.deserialize(
      String(architectureFixture.elements.get("subgraph-web")?.xywh),
    );
    const appNodeAfter = Bound.deserialize(
      String(architectureFixture.elements.get("shape-app")?.xywh),
    );
    expect(webGroupAfter.x - webGroupBefore.x).toBe(40);
    expect(webGroupAfter.y - webGroupBefore.y).toBe(24);
    expect(appNodeAfter.x - appNodeBefore.x).toBe(40);
    expect(appNodeAfter.y - appNodeBefore.y).toBe(24);
    expect(architectureFixture.source()).toContain(
      'service app(database)["App"] in web',
    );
  });

  test("writes Block, C4, Mindmap and Requirement GFX commands back to semantic Mermaid source", () => {
    installProjectedMermaidTestTheme();
    const c4Fixture = createMermaidGfxCommandFixture(
      'C4Context\n  Person(user, "User")\n  System(app, "App")\n  Rel(user, app, "Uses")\n',
    );
    const c4Model = getMermaidVisualModelForEditing(
      c4Fixture.std,
      c4Fixture.mermaidBlock,
    )!;
    const c4UserBinding = c4ProjectionSelectionId(c4Model, "element", "user")!;
    const c4UserNativeId = getMermaidGfxNode(
      c4Fixture.std.store,
      c4Fixture.mermaidBlock,
      c4UserBinding,
    )!.id;
    applyMermaidGfxEdgeCommand(
      {
        familyData: c4EdgeFamilyData({
          ...c4EdgeGfxData(c4Model.edges[0])!,
          relationshipKind: "BiRel",
          technology: "GraphQL",
        }),
        edgeId: c4Model.edges[0].id,
        label: "Synchronizes",
        model: c4Fixture.mermaidBlock,
        std: c4Fixture.std,
      } as never,
      () => undefined,
    );
    expect(c4Fixture.source()).toContain(
      'BiRel(user, app, "Synchronizes", "GraphQL")',
    );
    applyMermaidGfxNodeCommand(
      {
        familyData: c4NodeFamilyData({
          ...c4NodeGfxData(
            c4Model.nodes.find(
              (node) =>
                node.id === c4ProjectionSelectionId(c4Model, "element", "app"),
            )!,
          )!,
          kind: "ContainerDb",
        }),
        model: c4Fixture.mermaidBlock,
        nodeId: c4ProjectionSelectionId(c4Model, "element", "app")!,
        shape: "database",
        std: c4Fixture.std,
      } as never,
      () => undefined,
    );
    expect(c4Fixture.source()).toContain('ContainerDb(app, "App")');
    expect(
      getMermaidGfxNode(
        c4Fixture.std.store,
        c4Fixture.mermaidBlock,
        c4UserBinding,
      )!.id,
    ).toBe(c4UserNativeId);

    const c4BoundaryFixture = createMermaidGfxCommandFixture(
      [
        "C4Container",
        '  System_Boundary(apps, "Applications") {',
        '    Container(app, "App")',
        "  }",
      ].join("\n"),
    );
    const c4BoundaryModel = getMermaidVisualModelForEditing(
      c4BoundaryFixture.std,
      c4BoundaryFixture.mermaidBlock,
    )!;
    expect(c4BoundaryModel.subgraphs?.[0]).toMatchObject({
      id: c4ProjectionSelectionId(c4BoundaryModel, "boundary", "apps"),
      nodeIds: [c4ProjectionSelectionId(c4BoundaryModel, "element", "app")],
    });
    applyMermaidGfxSubgraphCommand(
      {
        model: c4BoundaryFixture.mermaidBlock,
        moveMembers: true,
        std: c4BoundaryFixture.std,
        subgraphId: c4ProjectionSelectionId(
          c4BoundaryModel,
          "boundary",
          "apps",
        )!,
        x: c4BoundaryModel.subgraphs![0].x + 40,
        y: c4BoundaryModel.subgraphs![0].y + 24,
      } as never,
      () => undefined,
    );
    expect(c4BoundaryFixture.source()).toContain(
      'System_Boundary(apps, "Applications") {',
    );
    expect(c4BoundaryFixture.source()).toContain('Container(app, "App")');
    const movedC4BoundaryModel = getMermaidVisualModelForEditing(
      c4BoundaryFixture.std,
      c4BoundaryFixture.mermaidBlock,
    )!;
    expect(movedC4BoundaryModel.subgraphs?.[0]).toMatchObject({
      id: c4ProjectionSelectionId(c4BoundaryModel, "boundary", "apps"),
      nodeIds: [c4ProjectionSelectionId(c4BoundaryModel, "element", "app")],
    });
    const movedC4BoundaryFrame = Bound.deserialize(
      c4BoundaryFixture.owner.xywh,
    );
    const movedC4BoundaryItems = [
      ...movedC4BoundaryModel.nodes,
      ...(movedC4BoundaryModel.subgraphs ?? []),
    ];
    expect(movedC4BoundaryFrame.w).toBeGreaterThanOrEqual(
      Math.max(...movedC4BoundaryItems.map((item) => item.x + item.width)) + 80,
    );
    expect(movedC4BoundaryFrame.h).toBeGreaterThanOrEqual(
      Math.max(...movedC4BoundaryItems.map((item) => item.y + item.height)) +
        80,
    );

    const nestedC4BoundaryFixture = createMermaidGfxCommandFixture(
      [
        "C4Container",
        '  System_Boundary(workspace, "Workspace") {',
        '    Container_Boundary(frontend, "Frontend") {',
        '      Container(app, "App")',
        "    }",
        "  }",
        'Person(outside, "Outside")',
      ].join("\n"),
    );
    const nestedC4BoundaryModel = getMermaidVisualModelForEditing(
      nestedC4BoundaryFixture.std,
      nestedC4BoundaryFixture.mermaidBlock,
    )!;
    expect(nestedC4BoundaryModel.subgraphs?.map(({ id }) => id)).toEqual([
      c4ProjectionSelectionId(nestedC4BoundaryModel, "boundary", "workspace"),
      c4ProjectionSelectionId(nestedC4BoundaryModel, "boundary", "frontend"),
    ]);
    const sourceBeforeGeometry = nestedC4BoundaryFixture.source();
    const appId = c4ProjectionSelectionId(
      nestedC4BoundaryModel,
      "element",
      "app",
    )!;
    const outsideId = c4ProjectionSelectionId(
      nestedC4BoundaryModel,
      "element",
      "outside",
    )!;
    const rootId = c4ProjectionSelectionId(
      nestedC4BoundaryModel,
      "boundary",
      "workspace",
    )!;
    const frontendId = c4ProjectionSelectionId(
      nestedC4BoundaryModel,
      "boundary",
      "frontend",
    )!;
    const root = nestedC4BoundaryModel.subgraphs!.find((g) => g.id === rootId)!;
    const outside = nestedC4BoundaryModel.nodes.find(
      (n) => n.id === outsideId,
    )!;
    applyMermaidGfxNodeCommand(
      {
        model: nestedC4BoundaryFixture.mermaidBlock,
        std: nestedC4BoundaryFixture.std,
        nodeId: appId,
        translate: { dx: 900, dy: 700 },
      } as never,
      () => undefined,
    );
    applyMermaidGfxNodeCommand(
      {
        model: nestedC4BoundaryFixture.mermaidBlock,
        std: nestedC4BoundaryFixture.std,
        nodeId: outsideId,
        translate: { dx: root.x - outside.x + 20, dy: root.y - outside.y + 20 },
      } as never,
      () => undefined,
    );
    const nodeBound = (id: string) =>
      Bound.deserialize(
        String(
          getMermaidGfxNode(
            nestedC4BoundaryFixture.std.store,
            nestedC4BoundaryFixture.mermaidBlock,
            id,
          )!.xywh,
        ),
      );
    const groupBound = () =>
      Bound.deserialize(
        String(
          nestedC4BoundaryFixture.elements.get(`subgraph-${frontendId}`)!.xywh,
        ),
      );
    const appBefore = nodeBound(appId),
      outsideBefore = nodeBound(outsideId),
      frontendBefore = groupBound();
    applyMermaidGfxSubgraphCommand(
      {
        model: nestedC4BoundaryFixture.mermaidBlock,
        std: nestedC4BoundaryFixture.std,
        subgraphId: rootId,
        moveMembers: true,
        x: root.x + 40,
        y: root.y + 24,
      } as never,
      () => undefined,
    );
    expect(nodeBound(appId).x - appBefore.x).toBe(40);
    expect(nodeBound(appId).y - appBefore.y).toBe(24);
    expect(groupBound().x - frontendBefore.x).toBe(40);
    expect(groupBound().y - frontendBefore.y).toBe(24);
    expect(nodeBound(outsideId)).toEqual(outsideBefore);
    const appAfterMove = nodeBound(appId),
      frontendAfterMove = groupBound();
    applyMermaidGfxSubgraphCommand(
      {
        model: nestedC4BoundaryFixture.mermaidBlock,
        std: nestedC4BoundaryFixture.std,
        subgraphId: rootId,
        width: root.width + 200,
        height: root.height + 100,
      } as never,
      () => undefined,
    );
    expect(nodeBound(appId)).toEqual(appAfterMove);
    expect(groupBound()).toEqual(frontendAfterMove);
    expect(nestedC4BoundaryFixture.source()).toBe(sourceBeforeGeometry);
    const geometryReadback = getMermaidVisualModelForEditing(
      nestedC4BoundaryFixture.std,
      nestedC4BoundaryFixture.mermaidBlock,
    )!;
    expect(
      geometryReadback.subgraphs!.find((g) => g.id === rootId)!.nodeIds,
    ).toEqual([]);
    expect(
      geometryReadback.subgraphs!.find((g) => g.id === frontendId)!.nodeIds,
    ).toEqual([appId]);
    applyMermaidGfxNodeCommand(
      {
        label: "Nested App",
        model: nestedC4BoundaryFixture.mermaidBlock,
        nodeId: c4ProjectionSelectionId(
          nestedC4BoundaryModel,
          "element",
          "app",
        )!,
        std: nestedC4BoundaryFixture.std,
      } as never,
      () => undefined,
    );
    expect(nestedC4BoundaryFixture.source()).toContain(
      'System_Boundary(workspace, "Workspace") {',
    );
    expect(nestedC4BoundaryFixture.source()).toContain(
      'Container_Boundary(frontend, "Frontend") {',
    );
    expect(nestedC4BoundaryFixture.source()).toContain(
      'Container(app, "Nested App")',
    );

    const afterRename = getMermaidVisualModelForEditing(
      nestedC4BoundaryFixture.std,
      nestedC4BoundaryFixture.mermaidBlock,
    )!;
    const renamedRoot = afterRename.subgraphs!.find((g) => g.id === rootId)!;
    const appAfterRename = nodeBound(appId),
      frontendAfterRename = groupBound();
    const renamedSource = nestedC4BoundaryFixture.source();
    applyMermaidGfxSubgraphCommand(
      {
        model: nestedC4BoundaryFixture.mermaidBlock,
        std: nestedC4BoundaryFixture.std,
        subgraphId: rootId,
        moveMembers: true,
        x: renamedRoot.x + 17,
        y: renamedRoot.y + 13,
      } as never,
      () => undefined,
    );
    expect(nodeBound(appId).x - appAfterRename.x).toBe(17);
    expect(nodeBound(appId).y - appAfterRename.y).toBe(13);
    expect(groupBound().x - frontendAfterRename.x).toBe(17);
    expect(groupBound().y - frontendAfterRename.y).toBe(13);
    expect(nodeBound(outsideId)).toEqual(outsideBefore);
    expect(nestedC4BoundaryFixture.source()).toBe(renamedSource);

    const blockFixture = createMermaidGfxCommandFixture(
      'block-beta\n  columns 2\n  A["Start"]\n  B["Done"]\n  A -- "next" ---> B\n  style B fill:#dcfce7,stroke:#16a34a,color:#052e16\n',
    );
    const blockModel = getMermaidVisualModelForEditing(
      blockFixture.std,
      blockFixture.mermaidBlock,
    )!;
    expect(
      readBlockProjectionModel(blockFixture.source(), blockModel)?.columns,
    ).toBe(2);
    const command = createBlockCommandConsumer({
      getSource: blockFixture.source,
      getReadonly: () => false,
      getVisualModel: () =>
        getMermaidVisualModelForEditing(
          blockFixture.std,
          blockFixture.mermaidBlock,
        )!,
      applyVisualModel: (visualModel, options) => {
        let result: { applied: boolean; diagnostic?: string } = {
          applied: false,
        };
        applyMermaidVisualModelCommand(
          {
            model: blockFixture.mermaidBlock,
            std: blockFixture.std,
            visualModel,
            ...options,
          } as never,
          (value) => {
            result = {
              applied: Boolean(value?.applied),
              diagnostic: value?.diagnostic,
            };
          },
        );
        return result;
      },
      selectAfterProjection: () => {},
    });
    expect(
      command("updateBlockColumns", [null, 1], blockFixture.source()).changed,
    ).toBe(true);
    expect(blockFixture.source()).toContain("columns 1");
    const oneColumnBlockModel = getMermaidVisualModelForEditing(
      blockFixture.std,
      blockFixture.mermaidBlock,
    )!;
    const blockNodeA = oneColumnBlockModel.nodes.find(
      (n) => n.label === "Start",
    )!;
    const blockNodeB = oneColumnBlockModel.nodes.find(
      (n) => n.label === "Done",
    )!;
    expect(blockNodeB.y).toBeGreaterThan(blockNodeA.y);
    expect(
      command(
        "updateBlock",
        [
          blockNodeA.id,
          {
            label:
              "Incoming request with attachments and a long schema revision",
          },
        ],
        blockFixture.source(),
      ).changed,
    ).toBe(true);
    // The real ensure consumer reads canonically serialized Style metadata.
    // Authored key order must not enlarge another block during Source replay.
    ensureMermaidProjectionOwnerCommand(
      {
        model: blockFixture.mermaidBlock,
        std: blockFixture.std,
        capture: false,
      } as never,
      () => undefined,
    );
    expect(
      getMermaidVisualModelForEditing(
        blockFixture.std,
        blockFixture.mermaidBlock,
      )!.nodes.find((n) => n.id === blockNodeB.id),
    ).toMatchObject({
      x: blockNodeB.x,
      y: blockNodeB.y,
      width: blockNodeB.width,
      height: blockNodeB.height,
    });
    const blockConnector = getMermaidGfxConnector(
      blockFixture.std.store,
      blockFixture.mermaidBlock,
      oneColumnBlockModel.edges[0].id,
    ) as unknown as {
      labelObstacleIds: string[];
      routingObstacleIds: string[];
    };
    const labelObstacles = [...blockConnector.labelObstacleIds];
    expect(labelObstacles.length).toBeGreaterThan(0);
    blockConnector.labelObstacleIds = [];
    blockConnector.routingObstacleIds = [];
    ensureMermaidProjectionOwnerCommand(
      {
        model: blockFixture.mermaidBlock,
        std: blockFixture.std,
        capture: false,
      } as never,
      () => undefined,
    );
    expect(blockConnector.labelObstacleIds).toEqual(labelObstacles);
    const startBound = new Bound(0, 0, 100, 60),
      endBound = new Bound(224, 0, 100, 60),
      intervening = new Bound(112, 0, 100, 60),
      protectedCorridor = new Bound(112, -80, 100, 220),
      route = new ConnectorPathGenerator({
        getElementById: () => null,
      }).generateOrthogonalConnectorPath({
        startBound,
        endBound,
        startPoint: new PointLocation([100, 30]),
        endPoint: new PointLocation([224, 30]),
        obstacleBounds: [intervening],
        protectedBounds: [protectedCorridor],
        clearance: 5.25,
      });
    expect(route.length).toBeGreaterThan(3);
    expect(route[0]).toEqual([100, 30]);
    expect(route.at(-1)).toEqual([224, 30]);
    for (let i = 1; i < route.length; i++)
      expect(
        protectedCorridor.isPointInBound(
          [
            (route[i - 1][0] + route[i][0]) / 2,
            (route[i - 1][1] + route[i][1]) / 2,
          ],
          0,
        ),
      ).toBe(false);
    applyMermaidGfxEdgeCommand(
      {
        edgeId: oneColumnBlockModel.edges[0].id,
        label: "ships",
        model: blockFixture.mermaidBlock,
        std: blockFixture.std,
      } as never,
      () => undefined,
    );
    expect(blockFixture.source()).toContain('A -- "ships" ---> B');

    const survivorKey = oneColumnBlockModel.nodes.find(
        (n) => n.label === "Done",
      )!.id,
      nativeId = getMermaidGfxNode(
        blockFixture.std.store,
        blockFixture.mermaidBlock,
        survivorKey,
      )!.id;
    expect(
      command(
        "updateBlock",
        [blockNodeA.id, { id: "Intake" }],
        blockFixture.source(),
      ).changed,
    ).toBe(true);
    expect(
      command(
        "addBlock",
        [{ id: "Before", before: survivorKey }],
        blockFixture.source(),
      ).changed,
    ).toBe(true);
    expect(
      getMermaidGfxNode(
        blockFixture.std.store,
        blockFixture.mermaidBlock,
        survivorKey,
      )!.id,
    ).toBe(nativeId);
    expect(blockFixture.source()).toContain('Intake -- "ships" ---> B');

    const mindmapFixture = createMermaidGfxCommandFixture(
      "mindmap\n  root((Myoxus))\n    Documents\n",
    );
    const mindmapModel = getMermaidVisualModelForEditing(
      mindmapFixture.std,
      mindmapFixture.mermaidBlock,
    )!;
    const documentsNode = mindmapModel.nodes.find(
      (node) => node.label === "Documents",
    )!;
    applyMermaidGfxNodeCommand(
      {
        label: "Diagrams",
        mindmapShape: "cloud",
        model: mindmapFixture.mermaidBlock,
        nodeId: documentsNode.id,
        shape: "cloud",
        std: mindmapFixture.std,
      } as never,
      () => undefined,
    );
    // Free GFX mutation cannot rewrite a Source-owned tree.
    expect(mindmapFixture.source()).toBe(
      "mindmap\n  root((Myoxus))\n    Documents\n",
    );
    const consumer = createMindmapCommandConsumer({
      getSource: mindmapFixture.source,
      getReadonly: () => false,
      getVisualModel: () => getMermaidVisualModel(mindmapFixture.mermaidBlock)!,
      applyVisualModel: (visualModel, options) => {
        let result = { applied: false };
        applyMermaidVisualModelCommand(
          {
            std: mindmapFixture.std,
            model: mindmapFixture.mermaidBlock,
            visualModel,
            sourceWrite: options?.sourceWrite,
          } as never,
          (value) => {
            result = { applied: value?.applied === true };
          },
        );
        return result;
      },
      selectAfterProjection: () => {},
      selectEmpty: () => {},
    });
    expect(
      consumer(
        {
          type: "rename",
          key: documentsNode.id,
          label: "Diagrams",
          shape: "cloud",
        },
        mindmapFixture.source(),
      ).changed,
    ).toBe(true);
    expect(mindmapFixture.source()).toContain("    )Diagrams(");
  });

  test("syncs owner GFX semantic edits after measured relayout", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    applyMermaidVisualModelCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
        visualModel: layoutMeasuredFlowchart(
          getMermaidVisualModelForEditing(fixture.std, fixture.mermaidBlock)!,
        ),
      } as never,
      () => {},
    );
    const shapeA = fixture.elements.get("shape-A") as {
      shapeType?: string;
      text?: string;
    };
    shapeA.text = "Reviewed start";
    shapeA.shapeType = "diamond";
    let payload: unknown = null;

    syncMermaidVisualModelFromProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    expect(payload).toMatchObject({ synced: true });
    expect(fixture.source()).toContain(
      "A{Reviewed start} edge-A-B-1@--> B[Done]",
    );
  });

  test("keeps compact source unchanged for a semantically unchanged owner", () => {
    const source = [
      "---",
      'title: "Flowchart"',
      "---",
      "flowchart LR",
      "  Start[Start] --> A1[Review] --> B1[Retry] --> Done1[Done]",
      "  Start --> A2[Validate] --> B2[Revise] --> Done2[Accepted]",
      "  Start --> A3[Plan] --> B3[Build] --> Done3[Shipped]",
      "  Start --> A4[Observe] --> B4[Learn] --> Done4[Improved]",
      "  Start --> A5[Draft] --> B5[Approve] --> Done5[Published]",
    ].join("\n");
    const fixture = createMermaidGfxCommandFixture(source);
    const sourceHash = fixture.mermaidBlock.props.sourceHash;
    let payload: unknown = null;

    syncMermaidVisualModelFromProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    expect(payload).toMatchObject({ sourceHash });
    expect(fixture.source()).toBe(source);
  });

  test("canonicalizes generated owner source before writing", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    const shapeA = fixture.elements.get("shape-A") as {
      text?: string;
    };
    shapeA.text = "Canonical start";
    let payload: { sourceHash?: string; synced?: boolean } | null = null;

    syncMermaidVisualModelFromProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next as { sourceHash?: string; synced?: boolean };
      },
    );

    const source = fixture.source();
    const syncPayload = payload as {
      sourceHash?: string;
      synced?: boolean;
    } | null;
    expect(syncPayload).toMatchObject({ synced: true });
    expect(source).toBe(normalizeMermaidSourceInput(source));
    expect(source.endsWith("\n")).toBe(false);
    expect(fixture.mermaidBlock.props.sourceHash).toBe(
      hashMermaidSource(source),
    );
    expect(syncPayload?.sourceHash).toBe(hashMermaidSource(source));
  });

  test("keeps Timeline reorder source-owned and outside owner GFX geometry", () => {
    const source = "timeline\n  section Web\n  2027 : Plan : Export\n";
    expect(parseMermaidSourceToGfxVisualModel(source).model).toBeNull();
    expect(
      parseMermaidTimelineSource(source)?.events.map((event) => event.label),
    ).toEqual(["Plan", "Export"]);
  });

  test("keeps State composite syntax and bindings through local commands and geometry sync", async () => {
    const source = [
      "stateDiagram-v2",
      '  state "Review flow" as Review {',
      "    [*] --> Draft",
      '    state "Needs QA" as QA',
      "    Draft --> QA : submit",
      "    QA --> [*] : approve",
      "  }",
      "  Review --> Done : close",
    ].join("\n");
    await prepareMermaidFamilySource(source);
    const fixture = createMermaidGfxCommandFixture(source);
    const visual = () =>
      getMermaidVisualModelForEditing(fixture.std, fixture.mermaidBlock)!;
    const command = createStateCommandConsumer({
      getSource: fixture.source,
      getReadonly: () => false,
      getVisualModel: visual,
      selectAfterProjection: () => undefined,
      applyVisualModel: (visualModel, options) => {
        let result = { applied: false };
        applyMermaidVisualModelCommand(
          {
            model: fixture.mermaidBlock,
            std: fixture.std,
            visualModel,
            ...options,
          } as never,
          (value) => {
            if (!value) throw new Error("Missing State commit result");
            result = value;
          },
        );
        return result;
      },
    });
    const reviewKey = visual().subgraphs!.find(
      (g) => stateProjectionBinding(g)?.sourceId === "Review",
    )!.id;
    expect(
      command(
        "editStateComposite",
        [reviewKey, { label: "Review lane" }],
        fixture.source(),
      ).changed,
    ).toBe(true);
    expect(fixture.source()).toContain('state "Review lane" as Review {');
    expect(fixture.source()).toContain("    Draft --> QA : submit");
    expect(fixture.source()).not.toContain("flowchart TD");

    const qaKey = visual().nodes.find(
      (n) => stateProjectionBinding(n)?.sourceId === "QA",
    )!.id;
    expect(
      command("setStateHeading", [qaKey, "Quality check"], fixture.source())
        .changed,
    ).toBe(true);
    expect(visual().subgraphs!.find((g) => g.id === reviewKey)).toBeDefined();
    const qaNode = fixture.elements.get(`shape-${qaKey}`) as { xywh: string };
    const moved = Bound.deserialize(qaNode.xywh);
    moved.x += 24;
    qaNode.xywh = moved.serialize();
    const editedSource = fixture.source();
    let syncPayload: unknown = null;

    syncMermaidVisualModelFromProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        syncPayload = next;
      },
    );

    expect(syncPayload).toMatchObject({ synced: true });
    expect(fixture.source()).toBe(editedSource);
    expect(fixture.source()).toContain('    state "Quality check" as QA');
    expect(fixture.source()).toContain("    QA --> [*] : approve");
    expect(fixture.source()).toContain("  Review --> Done : close");
    expect(fixture.source()).not.toContain("flowchart TD");
  });

  test("preserves Mermaid-specific node syntax when syncing label edits from GFX", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A([Start]) --> B[Done]\n",
    );
    const shapeA = fixture.elements.get("shape-A") as {
      text?: string;
    };
    shapeA.text = "Reviewed start";
    let payload: unknown = null;

    syncMermaidVisualModelFromProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    expect(payload).toMatchObject({ synced: true });
    expect(fixture.source()).toContain(
      "A([Reviewed start]) edge-A-B-1@--> B[Done]",
    );
  });

  test("reconciles label-only source edits even when source hash was already updated", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n  C[Result]\n",
    );
    const nextSource =
      "flowchart LR\n  A[Keyboard source] --> B[Keyboard target]\n  C[Keyboard spare]\n";
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);
    const parsedNextSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedNextSource.visualModelHash);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const shapeA = fixture.elements.get("shape-A") as { text?: string };
    const shapeB = fixture.elements.get("shape-B") as { text?: string };
    const shapeC = fixture.elements.get("shape-C") as { text?: string };
    expect(payload).toMatchObject({ changed: true });
    expect(shapeA.text).toBe("Keyboard source");
    expect(shapeB.text).toBe("Keyboard target");
    expect(shapeC.text).toBe("Keyboard spare");
    expect(fixture.source()).toBe(nextSource);
  });

  test("reloading a reordered persisted Flowchart never grows its group or moves its members", () => {
    const source =
      '---\ntitle: "Flowchart"\n---\nflowchart TD\n  subgraph SG8 ["Group 8"]\n    B{Decision} edge-B-C-2@--> |Yes| C[Done]\n  end\n  A[Start] edge-A-B-1@--> B\n  %% dummy\n  B edge-B-D-3@--> |No| D[Retry]\n';
    const fixture = createMermaidGfxCommandFixture(source);
    // Page-owned projection, actual persisted geometry and insertion order
    // from the reported diagram; parser order is B,C,A,D instead.
    vi.spyOn(fixture.std.store, "getParent").mockReturnValue({
      flavour: "myoxus:note",
    } as never);
    fixture.owner.xywh = "[-1264,70.6770705249915,1592,619]";
    const bounds = {
      "shape-A": "[88,70.6770705249915,160,88]",
      "shape-C": "[-1228,433.6770705249915,160,88]",
      "shape-D": "[-126,521.6770705249914,160,88]",
      "shape-B": "[-250,331.6770705249915,160,108]",
      "subgraph-SG8": "[-1264,195.6770705249915,1246,362]",
    };
    for (const [id, xywh] of Object.entries(bounds))
      fixture.elements.get(id)!.xywh = xywh;
    for (const id of ["shape-A", "shape-B", "shape-C", "shape-D"]) {
      const metadata = fixture.elements.get(id)!.yMap as {
        set: (key: string, value: string) => void;
      };
      metadata.set("mermaidDiagramTitle", "Flowchart");
    }
    fixture.childIds.splice(
      0,
      fixture.childIds.length,
      "shape-A",
      "shape-C",
      "shape-D",
      "shape-B",
      "connector-2",
      "connector-1",
      "connector-3",
      "subgraph-SG8",
    );
    for (let reload = 0; reload < 4; reload++) {
      ensureMermaidProjectionOwnerCommand(
        {
          model: fixture.mermaidBlock,
          preferSource: true,
          std: fixture.std,
        } as never,
        () => {},
      );
      for (const [id, xywh] of Object.entries(bounds))
        expect(fixture.elements.get(id)?.xywh).toBe(xywh);
      expect(fixture.source()).toBe(source);
    }
    // A missing persisted child during hydration is not permission to replace
    // existing user geometry with parser coordinates or drop that child.
    const missing = fixture.elements.get("shape-C")!;
    fixture.elements.delete("shape-C");
    const ownerBefore = fixture.owner.xywh;
    expect(
      readMermaidVisualModelFromProjectionGroup(
        fixture.std.store,
        fixture.owner as never,
        parseMermaidSourceToGfxVisualModel(source).model,
      ),
    ).toBeNull();
    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        preferSource: true,
        std: fixture.std,
      } as never,
      () => {},
    );
    expect(fixture.owner.xywh).toBe(ownerBefore);
    expect(fixture.elements.has("shape-C")).toBe(false);
    expect(fixture.source()).toBe(source);
    fixture.elements.set("shape-C", missing);
  });

  test("preserves owner GFX geometry during prefer-source connector replay", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Page mode] --> |edgeless path| B[Canvas mode]\n  C[Review mode]\n",
    );
    const movedShapeA = fixture.elements.get("shape-A") as {
      xywh?: string;
    };
    movedShapeA.xywh = "[520,340,180,96]";
    const nextSource =
      "flowchart TD\n  A[Page mode] --> |edgeless path| C[Review mode]\n  B[Canvas mode]\n";
    const parsedNextSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedNextSource.visualModelHash);
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        preferSource: true,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const connector = [...fixture.elements.values()].find(
      (element) => element.type === "connector",
    ) as { source?: { id?: string }; target?: { id?: string } } | undefined;
    expect(payload).toMatchObject({ changed: true });
    expect(movedShapeA.xywh).toBe("[520,340,180,96]");
    expect(connector?.source?.id).toBe("shape-A");
    expect(connector?.target?.id).toBe("shape-C");
    expect(fixture.source()).toBe(nextSource);
  });

  test("reflows owner GFX positions when source replay changes Flowchart direction or syntax", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start] --> B[Done]\n  C[Later]\n",
    );
    const existingNodeA = fixture.elements.get("shape-A") as
      { xywh?: string } | undefined;
    expect(existingNodeA).toBeTruthy();
    existingNodeA!.xywh = new Bound(120, 320, 220, 96).serialize();
    const nextSource = "flowchart-elk LR\n  A[Start] --> C[Later]\n  B[Done]";
    const parsedNextSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedNextSource.visualModelHash);
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        preferSource: true,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const nodeA = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidNodeId",
        ) === "A",
    ) as { xywh?: string } | undefined;
    const nodeC = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidNodeId",
        ) === "C",
    ) as { xywh?: string } | undefined;
    expect(payload).toMatchObject({ changed: true });
    expect(nodeA?.xywh).toBeTruthy();
    expect(nodeC?.xywh).toBeTruthy();
    const nodeABound = Bound.deserialize(String(nodeA?.xywh));
    const nodeCBound = Bound.deserialize(String(nodeC?.xywh));
    expect(nodeABound.w).toBe(220);
    expect(nodeABound.h).toBe(96);
    expect(nodeCBound.x).toBeGreaterThanOrEqual(nodeABound.x + nodeABound.w);
    expect(fixture.source()).toBe(nextSource);
  });

  test("keeps source-declared subgraph membership after prefer-source geometry preservation", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Keep]\n  C[Standalone]\n",
    );
    const existingNodeA = fixture.elements.get("shape-A") as
      { xywh?: string } | undefined;
    expect(existingNodeA).toBeTruthy();
    existingNodeA!.xywh = new Bound(100, 296, 340, 220).serialize();
    const nextSource = [
      "flowchart TD",
      "  subgraph SG [Review lane]",
      "    A[Draft]",
      "  end",
      "  B[Outside]",
    ].join("\n");
    const parsedNextSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedNextSource.visualModelHash);
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        preferSource: true,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const subgraph = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidSubgraphId",
        ) === "SG",
    ) as { xywh?: string } | undefined;
    const nodeA = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidNodeId",
        ) === "A",
    ) as { xywh?: string } | undefined;
    const nodeB = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidNodeId",
        ) === "B",
    ) as { xywh?: string } | undefined;
    expect(payload).toMatchObject({ changed: true });
    expect(subgraph?.xywh).toBeTruthy();
    expect(nodeA?.xywh).toBeTruthy();
    const subgraphBound = Bound.deserialize(String(subgraph?.xywh));
    const nodeBound = Bound.deserialize(String(nodeA?.xywh));
    expect(nodeBound.x + nodeBound.w / 2).toBeGreaterThanOrEqual(
      subgraphBound.x,
    );
    expect(nodeBound.x + nodeBound.w / 2).toBeLessThanOrEqual(
      subgraphBound.x + subgraphBound.w,
    );
    expect(nodeBound.y + nodeBound.h / 2).toBeGreaterThanOrEqual(
      subgraphBound.y,
    );
    expect(nodeBound.y + nodeBound.h / 2).toBeLessThanOrEqual(
      subgraphBound.y + subgraphBound.h,
    );
    expect(nodeB?.xywh).toBeTruthy();
    const nodeBBound = Bound.deserialize(String(nodeB?.xywh));
    const nodeBCenterX = nodeBBound.x + nodeBBound.w / 2;
    const nodeBCenterY = nodeBBound.y + nodeBBound.h / 2;
    expect(
      nodeBCenterX >= subgraphBound.x &&
        nodeBCenterX <= subgraphBound.x + subgraphBound.w &&
        nodeBCenterY >= subgraphBound.y &&
        nodeBCenterY <= subgraphBound.y + subgraphBound.h,
    ).toBe(false);
    expect(fixture.source()).toBe(nextSource);
  });

  test("keeps source-replayed connected nodes readable after preserving a resized source node", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Keep]\n  C[Standalone]\n",
    );
    const existingNodeA = fixture.elements.get("shape-A") as
      { xywh?: string } | undefined;
    expect(existingNodeA).toBeTruthy();
    existingNodeA!.xywh = new Bound(100, 296, 340, 220).serialize();
    const nextSource = "flowchart LR\n  A[Start] --> B[Review]";
    const parsedNextSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedNextSource.visualModelHash);
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        preferSource: true,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const nodeA = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidNodeId",
        ) === "A",
    ) as { id?: string; xywh?: string } | undefined;
    const nodeB = [...fixture.elements.values()].find(
      (element) =>
        element.type === "shape" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidNodeId",
        ) === "B",
    ) as { id?: string; xywh?: string } | undefined;
    const connector = [...fixture.elements.values()].find(
      (element) => element.type === "connector",
    ) as { source?: { id?: string }; target?: { id?: string } } | undefined;
    expect(payload).toMatchObject({ changed: true });
    expect(nodeA?.xywh).toBeTruthy();
    expect(nodeB?.xywh).toBeTruthy();
    const nodeABound = Bound.deserialize(String(nodeA?.xywh));
    const nodeBBound = Bound.deserialize(String(nodeB?.xywh));
    expect(nodeBBound.x).toBeGreaterThanOrEqual(nodeABound.x + nodeABound.w);
    expect(connector?.source?.id).toBe(nodeA?.id);
    expect(connector?.target?.id).toBe(nodeB?.id);
    expect(fixture.source()).toBe(nextSource);
  });

  test("keeps source-replayed standalone Flowchart nodes from overlapping preserved default geometry", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start]\n  B[Step]\n  C[Result]",
    );
    const nextSource = [
      "flowchart TD",
      "  A([Start])",
      "  B{Check}",
      "  C[Prepare]",
      "  D[(Store)]",
      "  E[/Input/]",
      "  F[[Subroutine]]",
      "  G((Review))",
      "  H{{Gate}}",
      "  I[\\Manual\\]",
      "  J([Done])",
    ].join("\n");
    const parsedNextSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedNextSource.visualModelHash);
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        preferSource: true,
        std: fixture.std,
      } as never,
      () => undefined,
    );

    const nodeBounds = [...fixture.elements.values()]
      .filter(
        (element) =>
          element.type === "shape" &&
          Boolean(
            (element.yMap as { get: (key: string) => unknown }).get(
              "mermaidNodeId",
            ),
          ),
      )
      .map((element) => Bound.deserialize(String(element.xywh)));
    expect(nodeBounds).toHaveLength(10);
    for (let firstIndex = 0; firstIndex < nodeBounds.length; firstIndex++) {
      const first = nodeBounds[firstIndex];
      for (
        let secondIndex = firstIndex + 1;
        secondIndex < nodeBounds.length;
        secondIndex++
      ) {
        const second = nodeBounds[secondIndex];
        const overlaps =
          first.x < second.x + second.w &&
          first.x + first.w > second.x &&
          first.y < second.y + second.h &&
          first.y + first.h > second.y;
        expect(overlaps).toBe(false);
      }
    }
    expect(fixture.source()).toBe(nextSource);
  });

  test("repairs missing owner GFX connectors when source projection is richer than the frame", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start]\n  B[Done]\n",
    );
    const sourceWithEdge = "flowchart TD\n  A[Start] --> B[Done]\n";
    const parsedWithEdge = parseMermaidSourceToVisualModel(sourceWithEdge);
    expectMermaidVisualHash(parsedWithEdge.visualModelHash);
    fixture.setSource(sourceWithEdge);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(sourceWithEdge);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const connectorEntry = [...fixture.elements.entries()].find(
      ([, element]) =>
        element.type === "connector" &&
        (element.yMap as { get: (key: string) => unknown }).get(
          "mermaidEdgeId",
        ) === "edge-A-B-1",
    );
    const connector = connectorEntry?.[1] as
      { source?: { id?: string }; target?: { id?: string } } | undefined;
    expect(payload).toMatchObject({ changed: true });
    expect(connector?.source?.id).toBe("shape-A");
    expect(connector?.target?.id).toBe("shape-B");
    expect(fixture.childIds).toContain(connectorEntry?.[0]);
    expect(fixture.source()).toBe(sourceWithEdge);
  });

  test("encloses an expanded source projection in its resized owner", () => {
    const fixture = createMermaidGfxCommandFixture(
      "flowchart TD\n  A[Start]\n  B[Done]\n",
    );
    const previousOwnerBound = Bound.deserialize(fixture.owner.xywh);
    const nextSource = [
      "flowchart TD",
      "  A([Start])",
      "  B{Check}",
      "  C[Prepare]",
      "  D[(Store)]",
      "  E[/Input/]",
      "  F[[Subroutine]]",
      "  G((Review))",
      "  H{{Gate}}",
      "  I[\\Manual\\]",
      "  J([Done])",
    ].join("\n");
    fixture.setSource(nextSource);
    fixture.mermaidBlock.props.sourceHash = hashMermaidSource(nextSource);
    const parsedWrappedRowsSource = parseMermaidSourceToVisualModel(nextSource);
    expectMermaidVisualHash(parsedWrappedRowsSource.visualModelHash);
    let payload: unknown = null;

    ensureMermaidProjectionOwnerCommand(
      {
        model: fixture.mermaidBlock,
        std: fixture.std,
      } as never,
      (next: unknown) => {
        payload = next;
      },
    );

    const ownerBound = Bound.deserialize(fixture.owner.xywh);
    const shapes = [...fixture.elements.values()]
      .filter((element) => element.type === "shape")
      .map((element) => Bound.deserialize(String(element.xywh)));
    expect(payload).toMatchObject({ changed: true });
    expect(ownerBound.w).toBeGreaterThan(previousOwnerBound.w);
    expect(
      shapes.every(
        (bound) =>
          bound.x >= ownerBound.x &&
          bound.y >= ownerBound.y &&
          bound.maxX <= ownerBound.maxX &&
          bound.maxY <= ownerBound.maxY,
      ),
    ).toBe(true);
  });

  test("edits visual edge labels and style through the visual model", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start] --> B[Done]\n",
    );
    const model = parsed.model!;
    const edgeId = model.edges[0].id;
    const labelled = renameMermaidVisualEdge(model, edgeId, "approved");
    const styled = setMermaidVisualEdgeStyle(labelled, edgeId, "dotted");
    const source = generateMermaidSourceFromVisualModel(styled);

    expect(styled.edges[0]).toMatchObject({
      label: "approved",
      style: "dotted",
    });
    expect(source).toContain("A[Start] -.-> |approved| B[Done]");
  });

  test("edits flowchart node shape and size through the visual model", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart-elk TD\n  A[Start] --> B[Done]\n",
    );
    const shaped = setMermaidVisualNodeShape(parsed.model!, "A", "rounded");
    const resized = resizeMermaidVisualNode(shaped, "A", 220, 96);
    const source = generateMermaidSourceFromVisualModel(resized);

    expect(resized.diagramType).toBe("flowchart-elk");
    expect(resized.nodes[0]).toMatchObject({
      height: 96,
      shape: "rounded",
      width: 220,
    });
    expect(source).toContain("flowchart-elk TD");
    expect(source).toContain("A(Start)");
  });

  test("connects and deletes existing flowchart objects without falling back to append-only source edits", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start]\n  B[Done]\n",
    );
    const connected = connectMermaidVisualNodes(parsed.model!, "A", "B");

    expect(connected.edges).toHaveLength(1);
    expect(generateMermaidSourceFromVisualModel(connected)).toContain(
      "A[Start] --> B[Done]",
    );

    const disconnected = deleteMermaidVisualSelection(connected, {
      edgeId: connected.edges[0].id,
    });
    expect(disconnected.edges).toHaveLength(0);
    expect(generateMermaidSourceFromVisualModel(disconnected)).toContain(
      "A[Start]",
    );
    expect(generateMermaidSourceFromVisualModel(disconnected)).toContain(
      "B[Done]",
    );

    const withoutNode = deleteMermaidVisualSelection(connected, {
      nodeId: "A",
    });
    expect(withoutNode.nodes.map((node) => node.id)).toEqual(["B"]);
    expect(withoutNode.edges).toHaveLength(0);
  });

  test("edits flowchart link types and reconnects existing edge endpoints", () => {
    const parsed = parseMermaidSourceToVisualModel(
      "flowchart TD\n  A[Start] --> B[Step]\n  C[Done]\n",
    );
    const edgeId = parsed.model!.edges[0].id;

    const reconnected = reconnectMermaidVisualEdge(
      parsed.model!,
      edgeId,
      "target",
      "C",
    );
    const bidirectional = setMermaidVisualEdgeLinkType(
      reconnected,
      edgeId,
      "bidirectional",
    );
    const circle = setMermaidVisualEdgeLinkType(
      bidirectional,
      edgeId,
      "circle",
    );
    const cross = setMermaidVisualEdgeLinkType(circle, edgeId, "cross");
    const open = setMermaidVisualEdgeLinkType(cross, edgeId, "open");

    expect(reconnected.edges[0]).toMatchObject({
      source: "A",
      target: "C",
    });
    expect(generateMermaidSourceFromVisualModel(bidirectional)).toContain(
      "A[Start] <--> C[Done]",
    );
    expect(generateMermaidSourceFromVisualModel(circle)).toContain(
      "A[Start] --o C[Done]",
    );
    expect(generateMermaidSourceFromVisualModel(cross)).toContain(
      "A[Start] --x C[Done]",
    );
    expect(generateMermaidSourceFromVisualModel(open)).toContain(
      "A[Start] --- C[Done]",
    );
  });
});
