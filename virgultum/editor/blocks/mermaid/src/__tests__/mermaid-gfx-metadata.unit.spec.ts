import { describe, expect, test } from "vitest";

import {
  MERMAID_GFX_EDGE_ROLE as MERMAID_FLOWCHART_EDGE_ROLE,
  MERMAID_GFX_NODE_ROLE as MERMAID_FLOWCHART_NODE_ROLE,
  MERMAID_GFX_SUBGRAPH_ROLE as MERMAID_FLOWCHART_SUBGRAPH_ROLE,
} from "../families/runtime/gfx-element-roles.js";
import {
  hasMermaidDanglingConnector,
  isManagedMermaidGfxElement,
  isMermaidGfxNodeModel,
  readMermaidGfxEdgeId,
  readMermaidGfxNodeDisplayLabel,
  readMermaidGfxNodeId,
  readMermaidGfxNodeLabel,
  readMermaidGfxRole,
  readMermaidGfxSubgraphId,
  resolveMermaidGfxNodeLabelsFromVisibleText,
  syncMermaidGfxNodeLabelsFromVisibleText,
  writeMermaidGfxMeta,
} from "../mermaid-gfx-metadata.js";

function createYMap(initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get: (key: string) => values.get(key),
    set: (key: string, value: unknown) => {
      values.set(key, value);
    },
    values,
  };
}

describe("Mermaid GFX metadata contract", () => {
  test("reads Mermaid roles and ids from yMap before props/direct fallbacks", () => {
    const yMap = createYMap({
      mermaidEdgeId: "edge-y",
      mermaidNodeDisplayLabel: "Display from yMap",
      mermaidNodeId: "node-y",
      mermaidNodeLabel: "Label from yMap",
      mermaidRole: MERMAID_FLOWCHART_NODE_ROLE,
      mermaidSubgraphId: "subgraph-y",
    });
    const model = {
      mermaidRole: "direct-role",
      props: {
        mermaidEdgeId: "edge-props",
        mermaidNodeDisplayLabel: "Display from props",
        mermaidNodeId: "node-props",
        mermaidNodeLabel: "Label from props",
        mermaidSubgraphId: "subgraph-props",
      },
      yMap,
    };

    expect(readMermaidGfxRole(model)).toBe(MERMAID_FLOWCHART_NODE_ROLE);
    expect(readMermaidGfxNodeId(model)).toBe("node-y");
    expect(readMermaidGfxNodeLabel(model)).toBe("Label from yMap");
    expect(readMermaidGfxNodeDisplayLabel(model)).toBe("Display from yMap");
    expect(readMermaidGfxEdgeId(model)).toBe("edge-y");
    expect(readMermaidGfxSubgraphId(model)).toBe("subgraph-y");
  });

  test("falls back to props/direct metadata for transient GFX-like models", () => {
    expect(
      readMermaidGfxRole({
        props: { mermaidRole: MERMAID_FLOWCHART_SUBGRAPH_ROLE },
      }),
    ).toBe(MERMAID_FLOWCHART_SUBGRAPH_ROLE);
    expect(
      readMermaidGfxRole({ mermaidRole: MERMAID_FLOWCHART_EDGE_ROLE }),
    ).toBe(MERMAID_FLOWCHART_EDGE_ROLE);
    expect(readMermaidGfxRole(null)).toBe("");
  });

  test("writes Mermaid metadata into yMap and props/direct model state", () => {
    const yMap = createYMap();
    const model: {
      mermaidNodeLabel?: string;
      props: Record<string, unknown>;
      yMap: ReturnType<typeof createYMap>;
    } = { props: {}, yMap };

    writeMermaidGfxMeta(model, "mermaidNodeLabel", "Renamed");

    expect(yMap.get("mermaidNodeLabel")).toBe("Renamed");
    expect(model.props.mermaidNodeLabel).toBe("Renamed");
    expect(model.mermaidNodeLabel).toBe("Renamed");
  });

  test("keeps semantic display labels from overwriting source labels", () => {
    const yMap = createYMap({
      mermaidNodeDisplayLabel: "Frontend\nserver",
      mermaidNodeLabel: "Frontend",
    });
    const model = { props: {}, yMap };

    expect(
      resolveMermaidGfxNodeLabelsFromVisibleText(model, "Frontendserver"),
    ).toEqual({
      displayLabel: "Frontend\nserver",
      label: "Frontend",
    });
    expect(
      syncMermaidGfxNodeLabelsFromVisibleText(model, "Frontendserver"),
    ).toBe(false);
    expect(yMap.get("mermaidNodeLabel")).toBe("Frontend");
    expect(yMap.get("mermaidNodeDisplayLabel")).toBe("Frontend\nserver");

    expect(
      resolveMermaidGfxNodeLabelsFromVisibleText(
        model,
        "Canvas Frontend\nserver",
      ),
    ).toEqual({
      displayLabel: "Canvas Frontend\nserver",
      label: "Canvas Frontend",
    });
    expect(
      syncMermaidGfxNodeLabelsFromVisibleText(model, "Canvas Frontend\nserver"),
    ).toBe(true);
    expect(yMap.get("mermaidNodeLabel")).toBe("Canvas Frontend");
    expect(yMap.get("mermaidNodeDisplayLabel")).toBe("Canvas Frontend\nserver");
  });

  test("recognizes managed flowchart GFX nodes, edges and subgraphs", () => {
    expect(
      isManagedMermaidGfxElement({
        props: { type: "shape" },
        yMap: createYMap({ mermaidRole: MERMAID_FLOWCHART_NODE_ROLE }),
      }),
    ).toBe(true);
    expect(
      isManagedMermaidGfxElement({
        type: "connector",
        yMap: createYMap({ mermaidRole: MERMAID_FLOWCHART_EDGE_ROLE }),
      }),
    ).toBe(true);
    expect(
      isManagedMermaidGfxElement({
        yMap: createYMap({ mermaidRole: MERMAID_FLOWCHART_SUBGRAPH_ROLE }),
      }),
    ).toBe(true);
    expect(isManagedMermaidGfxElement({ type: "note" })).toBe(false);
    expect(
      isMermaidGfxNodeModel({
        yMap: createYMap({ mermaidRole: MERMAID_FLOWCHART_NODE_ROLE }),
      }),
    ).toBe(true);
  });

  test("detects dangling connector endpoints against the owner children", () => {
    const allowed = new Set(["source", "target"]);
    expect(
      hasMermaidDanglingConnector(
        {
          source: { id: "source" },
          target: { id: "target" },
          type: "connector",
        },
        allowed,
      ),
    ).toBe(false);
    expect(
      hasMermaidDanglingConnector(
        {
          source: { id: "source" },
          target: { id: "missing" },
          type: "connector",
        },
        allowed,
      ),
    ).toBe(true);
    expect(
      hasMermaidDanglingConnector(
        {
          props: {
            source: { id: "source" },
            target: { id: "target" },
          },
          yMap: createYMap({ mermaidRole: MERMAID_FLOWCHART_EDGE_ROLE }),
        },
        allowed,
      ),
    ).toBe(false);
  });
});
