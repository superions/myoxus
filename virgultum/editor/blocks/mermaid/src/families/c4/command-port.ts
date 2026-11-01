// SPDX-License-Identifier: AGPL-3.0-or-later

import type { MermaidGfxActionContext } from "../runtime/editor-capabilities.js";
import type { C4ReactHostProps } from "./react-host-contract.js";
import {
  runC4Command,
  type C4CommandArgs,
  type C4CommandName,
} from "./actions.js";
import { readC4ProjectionModel } from "./gfx-data.js";
import { c4ModelToGfxVisualModel } from "./visual-model.js";
import { sizeC4ContentNode } from "./content-projection.js";
import { c4ContentGeometry } from "./node-projection.js";
import { readC4Config } from "../../engine/c4/config.js";
import type { MermaidC4Model } from "../../engine/c4/index.js";
import { layoutC4Diagram, reflowC4SourceScopes } from "./layout.js";
import {
  c4BoundaryHeaderHeight,
  projectC4BoundaryPresentation,
} from "./boundary-projection.js";
import { c4BoundaryPresentation } from "./gfx-data.js";
import {
  createMermaidVisualFamilyData,
  mermaidVisualFamilyPayload,
} from "../runtime/gfx-family-data.js";
import type { C4CommandResult } from "../../engine/c4/index.js";
import type { MermaidVisualModel } from "../runtime/gfx-model.js";
import { mermaidMessages as m } from "../../i18n.js";
import { placeNewC4CommandObjects } from "./command-placement.js";

export type C4CommandPort = Pick<
  MermaidGfxActionContext,
  "applyVisualModel" | "previewVisualModel" | "selectAfterProjection"
> & {
  getSource: () => string;
  getReadonly: () => boolean;
  getVisualModel: () => MermaidVisualModel;
};

/** Advance Source bindings while retaining every surviving presentation owner.
 * Content grows at the retained width; an actual native width edit replaces
 * that width. Packing is limited to the command's declared scopes. */
export function projectC4Command(
  result: C4CommandResult,
  stored: MermaidVisualModel,
  previous?: MermaidC4Model,
) {
  const model = result.model;
  const parsed = c4ModelToGfxVisualModel({
    ...model,
    ...layoutC4Diagram(model),
  });
  const widthChanged =
    !!previous &&
    !Object.is(
      c4ContentGeometry(readC4Config(previous.sourceDocument).effective).width,
      c4ContentGeometry(readC4Config(model.sourceDocument).effective).width,
    );
  const nodes = new Map(stored.nodes.map((n) => [n.id, n]));
  const groups = new Map(stored.subgraphs?.map((g) => [g.id, g]));
  const edges = new Map(stored.edges.map((e) => [e.id, e]));
  const visual: MermaidVisualModel = {
    ...parsed,
    nodes: parsed.nodes.map((n) => {
      const old = nodes.get(n.id);
      if (!old) return n;
      const retained = {
        ...n,
        x: old.x,
        y: old.y,
        width: widthChanged ? n.width : old.width,
        height: old.height,
      };
      return sizeC4ContentNode(retained);
    }),
    subgraphs: parsed.subgraphs?.map((g) => {
      const old = groups.get(g.id);
      if (!old) {
        if (g.id !== result.selection || !result.boundaryFromSelection)
          return g;
        const selected = result.boundaryFromSelection.map((id) =>
          nodes.get(id),
        );
        if (selected.some((n) => !n))
          throw new Error("C4 grouping lost a selected live object");
        const retained = selected.filter((n) => !!n);
        const margin = Math.max(
          0,
          readC4Config(model.sourceDocument).config.c4ShapeMargin ?? 50,
        );
        const left = Math.min(...retained.map((n) => n.x)),
          top = Math.min(...retained.map((n) => n.y));
        const width = Math.max(
          c4ContentGeometry(readC4Config(model.sourceDocument).effective)
            .width +
            margin * 2,
          Math.max(...retained.map((n) => n.x + n.width)) - left + margin * 2,
        );
        const header = Math.max(
          margin,
          c4BoundaryHeaderHeight({ ...g, width }),
        );
        return {
          ...g,
          x: left - margin,
          y: top - header,
          width,
          height:
            Math.max(...retained.map((n) => n.y + n.height)) -
            top +
            header +
            margin,
        };
      }
      const presentation = c4BoundaryPresentation(old.familyData);
      return {
        ...g,
        x: old.x,
        y: old.y,
        width: result.measureContent ? g.width : old.width,
        height: result.measureContent ? g.height : old.height,
        familyData: createMermaidVisualFamilyData("c4", {
          ...mermaidVisualFamilyPayload(g.familyData, "c4"),
          ...presentation,
        }),
      };
    }),
    edges: parsed.edges.map((e) => {
      const old = edges.get(e.id);
      return old && old.source === e.source && old.target === e.target
        ? {
            ...e,
            sourcePosition: old.sourcePosition,
            targetPosition: old.targetPosition,
            sourcePortId: old.sourcePortId,
            targetPortId: old.targetPortId,
            connectorMode: old.connectorMode,
            labelPlacement: old.labelPlacement,
          }
        : e;
    }),
  };
  return reflowC4SourceScopes(
    projectC4BoundaryPresentation(
      placeNewC4CommandObjects(
        visual,
        stored,
        model,
        result.boundaryFromSelection?.length ? result.selection : undefined,
      ),
    ),
    model,
    result.reflowScopes ?? [],
  );
}

/** Preview and Apply execute the same command against the committed basis.
 * A candidate is never installed as the controls' Source model. */
export function createC4CommandConsumer(port: C4CommandPort): {
  onCommand: C4ReactHostProps["onCommand"];
  previewCommand: NonNullable<C4ReactHostProps["previewCommand"]>;
} {
  const select = (visual: MermaidVisualModel, key?: string) => {
    const kind = visual.nodes.some((n) => n.id === key)
      ? "node"
      : visual.edges.some((e) => e.id === key)
        ? "edge"
        : visual.subgraphs?.some((g) => g.id === key)
          ? "subgraph"
          : null;
    if (key && kind) {
      port.selectAfterProjection({ editKey: key, kind });
      return key;
    }
    return undefined;
  };
  const prepare = <K extends C4CommandName>(
    name: K,
    args: C4CommandArgs<K>,
    basis: string,
  ) => {
    if (port.getReadonly()) return { diagnostic: m.ganttReadOnly() };
    const source = port.getSource();
    if (basis !== source) return { diagnostic: m.chartSourceChanged() };
    const stored = port.getVisualModel(),
      model = readC4ProjectionModel(source, stored);
    if (!model) return { diagnostic: m.classPatchRejected() };
    const result = runC4Command(model, name, args);
    if (result.status === "invalid") return { diagnostic: result.diagnostic };
    if (result.status === "unchanged") return { result };
    return { result, visual: projectC4Command(result, stored, model) };
  };
  return {
    onCommand: (name, args, basis) => {
      const candidate = prepare(name, args, basis);
      if (!candidate.result)
        return { changed: false, diagnostic: candidate.diagnostic };
      if (!candidate.visual) {
        // Selecting an existing native pair is a valid command with no write.
        const key = select(port.getVisualModel(), candidate.result.selection);
        return { changed: false, sourceBasis: basis, selection: key };
      }
      const result = candidate.result;
      const commit = port.applyVisualModel(candidate.visual, {
        preserveSourceBytes: true,
        sourceWrite: { baseSource: basis, source: result.source },
      });
      if (!commit.applied)
        return {
          changed: false,
          diagnostic: commit.diagnostic ?? m.classPatchRejected(),
        };
      const key = select(candidate.visual, result.selection);
      return { changed: true, sourceBasis: result.source, selection: key };
    },
    previewCommand: (name, args, basis) => {
      const candidate = prepare(name, args, basis);
      return {
        feedback: {
          changed: false,
          diagnostic:
            candidate.diagnostic ??
            (candidate.visual && !port.previewVisualModel
              ? m.classPatchRejected()
              : undefined),
        },
        dispose:
          candidate.visual && port.previewVisualModel
            ? port.previewVisualModel(candidate.visual)
            : () => undefined,
      };
    },
  };
}
