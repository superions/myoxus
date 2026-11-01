// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  resolveMermaidBlockSource,
  updateBlock,
  addBlock,
  updateBlockColumns,
  addBlockComposite,
  addBlockSpace,
} from "../../../engine/block/index.js";
import { blockModelToVisual } from "../visual-model.js";
import {
  readBlockProjectionModel,
  canonicalizeBlockVisual,
  reconcileBlockVisual,
  applyBlockGfxVisualToSource,
  blockGeometrySelection,
  reconcileBlockGeometryGesture,
} from "../source-application.js";
import { projectBlockNativeRenderEdges } from "../native-render-projection.js";
import { blockArrowContour } from "../block-projection.js";
import { blockCommandReflowScopes } from "../actions.js";
import { blockGfxHooks } from "../runtime.js";
const source =
  'block-beta\ncolumns 4\nA["Incoming request"] space\nblock:Process["Process"]:2\n columns 2\n B["Validate"]\n block:Store["Storage"]\n  columns 1\n  C["Object store"] D["Audit log"]\n end\nend\nE<["Dispatch"]>(right,down)\nA --> B\nA ~~~ B\nA --x B\n';
const model = () => resolveMermaidBlockSource(source).model!;
describe("prepared Block Source/GFX owner boundary", () => {
  it("keeps moved neighbours and technical identities through rename, insertion and exact readback", () => {
    const m = model(),
      visual = blockModelToVisual(m),
      a = m.nodes.find((n) => n.id === "A")!,
      d = m.nodes.find((n) => n.id === "D")!;
    const moved = visual.nodes.find((n) => n.id === d.sourceKey)!;
    moved.x += 95;
    moved.y += 50;
    const committed = canonicalizeBlockVisual(blockModelToVisual(m), visual);
    expect(committed.nodes.find((n) => n.id === d.sourceKey)).toMatchObject({
      x: moved.x,
      y: moved.y,
    });
    const renamed = updateBlock(m, a.sourceKey, {
      id: "Input",
      label: "Checked request",
    });
    expect(renamed.status).toBe("changed");
    const inserted = addBlock(renamed.model, { id: "X" });
    expect(inserted.changed).toBe(true);
    expect(
      blockCommandReflowScopes("addBlock", [{ id: "X" }], inserted),
    ).toEqual([]);
    const reconciled = reconcileBlockVisual(
      blockModelToVisual(inserted.model),
      visual,
    );
    expect(reconciled.nodes.find((n) => n.id === d.sourceKey)).toMatchObject({
      x: moved.x,
      y: moved.y,
    });
    const bound = readBlockProjectionModel(inserted.source, reconciled)!;
    const arrow = m.nodes.find((n) => n.id === "E")!;
    const cold = blockModelToVisual(
      resolveMermaidBlockSource(inserted.source).model!,
    );
    const rebound = canonicalizeBlockVisual(cold, reconciled);
    expect(
      rebound.nodes.find((n) => n.id === arrow.sourceKey)?.details,
    ).toEqual(visual.nodes.find((n) => n.id === arrow.sourceKey)!.details);
    expect(bound.nodes.find((n) => n.id === "Input")!.sourceKey).toBe(
      a.sourceKey,
    );
    const readback = applyBlockGfxVisualToSource(inserted.source, reconciled);
    expect(readback.source).toBe(inserted.source);
    const scopes = updateBlockColumns(
      bound,
      bound.groups.find((g) => g.id === "Store")!.bodyKey,
      2,
    );
    const local = reconcileBlockVisual(
      blockModelToVisual(scopes.model),
      reconciled,
      true,
      scopes.impact.grids,
    );
    const originalRoot = reconciled.nodes.find((n) => n.id === a.sourceKey)!;
    expect(local.nodes.find((n) => n.id === a.sourceKey)).toMatchObject({
      x: originalRoot.x,
      y: originalRoot.y,
      width: originalRoot.width,
      height: originalRoot.height,
    });
    const freelyResized = local.nodes.find((n) => n.id === a.sourceKey)!;
    freelyResized.width /= 2;
    const preceding = addBlock(scopes.model, {
      id: "Preceding",
      before: a.sourceKey,
    });
    const shifted = reconcileBlockVisual(
      blockModelToVisual(preceding.model),
      local,
    );
    expect(shifted.nodes.find((n) => n.id === a.sourceKey)).toMatchObject({
      x: freelyResized.x,
      y: freelyResized.y,
      width: freelyResized.width,
      height: freelyResized.height,
    });
  });
  it("reflows only the confirmed grouping and Space scopes", () => {
    const m = model(),
      visual = blockModelToVisual(m);
    const a = m.nodes.find((n) => n.id === "A")!,
      arrow = m.nodes.find((n) => n.id === "E")!,
      nested = m.nodes.find((n) => n.id === "C")!;
    visual.nodes.find((n) => n.id === nested.sourceKey)!.x += 30;
    const grouped = addBlockComposite(m, {
      id: "Group",
      children: [a.sourceKey, arrow.sourceKey],
    });
    expect(grouped.status).toBe("changed");
    const scopes = blockCommandReflowScopes(
      "addBlockComposite",
      [{ id: "Group", children: [a.sourceKey, arrow.sourceKey] }],
      grouped,
    );
    expect(scopes).toContain(grouped.selection);
    const next = reconcileBlockVisual(
      blockModelToVisual(grouped.model),
      visual,
      true,
      scopes,
    );
    const group = next.subgraphs!.find((g) => g.id === grouped.selection)!;
    expect(next.nodes.find((n) => n.id === a.sourceKey)!.x).toBeGreaterThan(
      group.x,
    );
    const space = addBlockSpace(m, {
      parent: m.groups.find((g) => g.id === "Store")!.bodyKey,
      before: nested.sourceKey,
    });
    const spaceScopes = blockCommandReflowScopes(
      "addBlockSpace",
      [{ parent: nested.parentKey }],
      space,
    );
    expect(spaceScopes).toEqual([nested.parentKey]);
    const local = reconcileBlockVisual(
      blockModelToVisual(space.model),
      visual,
      true,
      spaceScopes,
    );
    expect(local.nodes.find((n) => n.id === a.sourceKey)!.x).toBe(
      visual.nodes.find((n) => n.id === a.sourceKey)!.x,
    );
    expect(
      local.nodes.find((n) => n.id === nested.sourceKey)!.y,
    ).toBeGreaterThan(visual.nodes.find((n) => n.id === nested.sourceKey)!.y);
  });
  it("adopts existing semantic Surface keys and moved geometry without a parallel decoder", () => {
    const parsed = blockModelToVisual(model());
    const stored = structuredClone(parsed);
    const sourceIds = new Map(
      [...parsed.nodes, ...parsed.subgraphs!].map((n) => [
        n.id,
        String(
          n.familyData!.payload.binding &&
            (n.familyData!.payload.binding as { sourceId: string }).sourceId,
        ),
      ]),
    );
    stored.familyData = undefined;
    stored.nodes = stored.nodes.map((n) => ({
      ...n,
      id: sourceIds.get(n.id)!,
      familyData: undefined,
      x: n.x + 95,
    }));
    stored.subgraphs = stored.subgraphs!.map((g) => ({
      ...g,
      id: sourceIds.get(g.id)!,
      familyData: undefined,
    }));
    const canonical = canonicalizeBlockVisual(parsed, stored);
    const reconciled = reconcileBlockVisual(canonical, stored, false);
    expect(reconciled.nodes.find((n) => n.id === "A")!.x).toBe(
      stored.nodes.find((n) => n.id === "A")!.x,
    );
    const bound = readBlockProjectionModel(source, stored)!;
    expect(bound.nodes.find((n) => n.id === "A")!.sourceKey).toBe("A");
    const renamed = updateBlock(bound, "A", { id: "Input" });
    const inserted = addBlock(renamed.model, { id: "Extra" });
    const next = reconcileBlockVisual(
      blockModelToVisual(inserted.model),
      reconciled,
      false,
    );
    expect(next.nodes.find((n) => n.id === "A")!.x).toBe(
      stored.nodes.find((n) => n.id === "A")!.x,
    );
    expect(
      next.nodes.find((n) => n.id === "A")!.familyData!.payload.binding,
    ).toMatchObject({ sourceId: "Input" });
  });
  it("projects real local columns and exact composite moving sets without resize or spatial membership", () => {
    const m = model(),
      visual = blockModelToVisual(m),
      c = m.nodes.find((n) => n.id === "C")!,
      d = m.nodes.find((n) => n.id === "D")!,
      group = m.groups.find((g) => g.id === "Store")!,
      process = m.groups.find((g) => g.id === "Process")!,
      a = m.nodes.find((n) => n.id === "A")!;
    expect(visual.nodes.find((n) => n.id === d.sourceKey)!.y).toBeGreaterThan(
      visual.nodes.find((n) => n.id === c.sourceKey)!.y,
    );
    const moving = blockGeometrySelection(visual, [process.sourceKey]);
    expect(moving).toContain(group.sourceKey);
    expect(moving).toContain(c.sourceKey);
    expect(moving).not.toContain(a.sourceKey);
    expect(
      blockGfxHooks.hooks.descendantSubgraphIds?.(visual, process.sourceKey),
    ).toEqual(new Set([group.sourceKey]));
    expect(
      blockGfxHooks.hooks.descendantSubgraphIds?.(visual, group.sourceKey),
    ).toEqual(new Set());
    const moved = structuredClone(visual),
      frame = moved.subgraphs!.find((g) => g.id === group.sourceKey)!;
    frame.x += 45;
    frame.y += 60;
    const next = reconcileBlockGeometryGesture(visual, moved);
    expect(next.nodes.find((n) => n.id === c.sourceKey)!.x).toBe(
      visual.nodes.find((n) => n.id === c.sourceKey)!.x + 45,
    );
    const resized = structuredClone(visual);
    resized.subgraphs!.find((g) => g.id === group.sourceKey)!.width += 100;
    expect(
      reconcileBlockGeometryGesture(visual, resized).nodes.find(
        (n) => n.id === c.sourceKey,
      )!.x,
    ).toBe(visual.nodes.find((n) => n.id === c.sourceKey)!.x);
    expect(applyBlockGfxVisualToSource(source, next).source).toBe(source);
  });
  it("keeps native visible parallel occurrences and finite editable overflow projections", async () => {
    const edges = [{ id: "1-A-B" }, { id: "2-A-B" }, { id: "3-A-B" }];
    expect(projectBlockNativeRenderEdges(source, edges)).toEqual([
      edges[0],
      edges[2],
    ]);
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    const nativeSource = source + 'A o-- "retained" --x B\n';
    const diagram = await mermaid.mermaidAPI.getDiagramFromText(nativeSource);
    const db = diagram.db as {
      getEdges(): { id: string; start: string; end: string }[];
      getBlocksFlat(): { id: string }[];
    };
    expect(
      db.getEdges().map((edge) => [edge.id, edge.start, edge.end]),
    ).toEqual([
      ["1-A-B", "A", "B"],
      ["2-A-B", "A", "B"],
      ["3-A-B", "A", "B"],
      ["4-A-B", "A", "B"],
    ]);
    expect(db.getBlocksFlat().map((node) => node.id)).not.toContain("~~~");
    expect(db.getBlocksFlat().map((node) => node.id)).not.toContain("o");
    expect(
      projectBlockNativeRenderEdges(nativeSource, db.getEdges()).map(
        (edge) => edge.id,
      ),
    ).toEqual(["1-A-B", "3-A-B", "4-A-B"]);
    expect(blockArrowContour(["right", "down"], 180, 96, 12)).toHaveLength(3);
    for (const value of [
      "0",
      "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
    ]) {
      const raw = `block-beta\ncolumns ${value}\nA:${value} space:${value} B\n`,
        m = resolveMermaidBlockSource(raw).model!;
      expect(m).not.toBeNull();
      expect(m.sourceDocument.source).toBe(raw);
      const v = blockModelToVisual(m);
      expect(
        v.nodes.every((n) =>
          [n.x, n.y, n.width, n.height].every(Number.isFinite),
        ),
      ).toBe(true);
      expect(m.diagnostics.some((d) => d.stage === "render")).toBe(true);
    }
  });
});
