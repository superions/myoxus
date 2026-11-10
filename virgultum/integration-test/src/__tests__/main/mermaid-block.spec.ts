// SPDX-License-Identifier: AGPL-3.0-or-later

// This isolated browser fixture has no branding API. Use the generated
// server projection so Mermaid exercises its real theme contract.
import "../../../../../client/branding/theme-fallback.css";

import {
  applyMermaidVisualModelCommand,
  createMermaidClipboardPayloadV2,
  createMermaidFamilyReactRendererHost,
  getMermaidBlockSource,
  getMermaidSourceAuthoritativeVisualModel,
  insertMermaidBlockCommand,
  insertMermaidEdgelessDiagramCommand,
  MermaidFamilyReactHostExtension,
  mermaidFlowchartRendererToken,
  mermaidPieRendererToken,
  type MermaidFlowchartReactHostProps,
  type MermaidPieReactHostProps,
  parseMermaidSourceToGfxVisualModel,
  pasteMermaidClipboardPayloadV2,
  renameMermaidVisualNode,
  setMermaidBlockText,
} from "@virgultum/editor/blocks/mermaid";
import { getSurfaceBlock } from "@virgultum/editor/blocks/surface";
import { EditorI18nExtension } from "@virgultum/editor/shared/services";
import {
  type ConnectorElementModel,
  type FrameBlockModel,
  type MermaidBlockModel,
  type NoteBlockModel,
  NoteDisplayMode,
  type ParagraphBlockModel,
} from "@virgultum/model";
import { beforeEach, describe, expect, test } from "vitest";
import { html } from "lit";
import { Bound, almostEqual } from "@virgultum/global/gfx";
import { GfxControllerIdentifier } from "@virgultum/std/gfx";
import { encodeStateAsUpdate } from "yjs";

import { collectEmbeddedMermaidRootExclusions } from "../../../../editor/blocks/mermaid/src/presentation/embedded-child-visibility.js";
import { createMermaidOwnerGfxQuery } from "../../../../editor/blocks/mermaid/src/presentation/owner-gfx-query.js";
import { resolveMermaidGfxProjection } from "../../../../editor/blocks/mermaid/src/presentation/gfx-projection-owner.js";
import { planLinkedMermaidOwnerMigration } from "../../../../editor/blocks/mermaid/src/presentation/migrate-linked-owners.js";
import { MermaidOwnerMigrationExtension } from "../../../../editor/blocks/mermaid/src/presentation/mermaid-owner-migration-extension.js";
import { writeMermaidSourceModelState } from "../../../../editor/blocks/mermaid/src/mermaid-source-write.js";
import {
  preserveMermaidProjectionOwnerGeometry,
  resolveMermaidProjectionOwnerBoundForVisualModel,
} from "../../../../editor/blocks/mermaid/src/commands/materialization.js";
import { wait } from "../utils/common.js";
import { addNote } from "../utils/edgeless.js";
import { setupEditor } from "../utils/setup.js";

const FLOWCHART_SOURCE = [
  "flowchart TD",
  "  A[Start] --> B[Review]",
  "  B --> C[Done]",
].join("\n");
const PIE_SOURCE = 'pie\n  title Readiness\n  "Ready" : 7\n  "Open" : 3';

function getHost() {
  if (!editor.host) throw new Error("Editor host is not mounted");
  return editor.host;
}

function getMermaidBlock(blockId: string) {
  const model = doc.getBlock(blockId)?.model;
  if (model?.flavour !== "myoxus:mermaid") {
    throw new Error(`Cannot find Mermaid owner ${blockId}`);
  }
  return model as MermaidBlockModel;
}

function getFrame(frameId: string) {
  const model = doc.getBlock(frameId)?.model;
  if (model?.flavour !== "myoxus:frame") {
    throw new Error(`Cannot find Mermaid legacy frame ${frameId}`);
  }
  return model as FrameBlockModel;
}

function getSurface() {
  const surface = getSurfaceBlock(doc);
  if (!surface) throw new Error("Cannot find integration surface");
  return surface;
}

function addParagraph(displayMode = NoteDisplayMode.DocAndEdgeless) {
  const noteId = addNote(doc, { displayMode });
  const note = doc.getBlock(noteId)?.model as NoteBlockModel;
  const paragraph = note.children[0] as ParagraphBlockModel;
  return { note, paragraph };
}

async function insertEmbedded(
  paragraph: ParagraphBlockModel,
  source = FLOWCHART_SOURCE,
) {
  const [ok, context] = getHost().std.command.exec(insertMermaidBlockCommand, {
    selectedModels: [paragraph],
    source,
  });
  expect(ok).toBe(true);
  expect(context.insertedMermaidDiagram).toBeDefined();
  await wait();
  return context.insertedMermaidDiagram!;
}

async function insertNative(source = FLOWCHART_SOURCE) {
  const [ok, context] = getHost().std.command.exec(
    insertMermaidEdgelessDiagramCommand,
    { source },
  );
  expect(ok).toBe(true);
  expect(context.insertedMermaidDiagram).toBeDefined();
  await wait();
  return context.insertedMermaidDiagram!;
}

function modelBound(id: string) {
  const model = getSurface().getElementById(id) as { xywh?: string } | null;
  return model?.xywh ?? null;
}

function connectorEndpoints(id: string) {
  const connector = getSurface().getElementById(
    id,
  ) as ConnectorElementModel | null;
  return [connector?.source.id, connector?.target.id];
}

function ownerConnectorIds(owner: MermaidBlockModel) {
  return owner.childIds.filter(
    (id) =>
      (getSurface().getElementById(id) as { type?: string } | null)?.type ===
      "connector",
  );
}

function makeLegacyLinkedOwner(owner: MermaidBlockModel, frameXYWH: string) {
  const surface = getSurface();
  const frameId = doc.addBlock("myoxus:frame", { xywh: frameXYWH }, surface.id);
  const frame = getFrame(frameId);
  const childIds = [...owner.childIds];
  frame.props.childElementIds = Object.fromEntries(
    childIds.map((id) => [id, true]),
  );
  owner.props.childElementIds = {};
  owner.yBlock.set("prop:reference", frameId);
  return { childIds, frame };
}

function migrationTargetIds(
  plan: ReturnType<typeof planLinkedMermaidOwnerMigration>,
) {
  return plan.decisions.flatMap((decision) =>
    decision.kind === "migrate"
      ? [
          ...decision.plan.childIds,
          ...(decision.plan.createNote ? [decision.plan.createNote.id] : []),
        ]
      : [],
  );
}

beforeEach(async () => {
  // This framework fixture exercises ownership, commands and persistence, not
  // the consuming React shell. Keep the real GFX workarea mounted and fail on
  // unregistered families, while supplying the shell's required host boundary.
  const familyHost = createMermaidFamilyReactRendererHost([
    {
      token: mermaidFlowchartRendererToken,
      nativeView: () => null,
      render: (props: MermaidFlowchartReactHostProps) =>
        html`${props.workarea}${props.workareaFooter}`,
    },
    {
      token: mermaidPieRendererToken,
      render: (props: MermaidPieReactHostProps) =>
        html`${props.items.map((item) => html`<span>${item.label}: ${item.value}</span>`)}`,
    },
  ]);
  const cleanup = await setupEditor("edgeless", [
    EditorI18nExtension(),
    MermaidFamilyReactHostExtension({
      ...familyHost,
      renderEmbeddedTitle: (props) => html`<span>${props.title}</span>`,
      renderBlockShell: (props) =>
        html`<section>${props.body}${props.sourcePreview}</section>`,
      renderShellNotice: (props) =>
        html`<p>${props.title}: ${props.message}</p>`,
    }),
  ]);
  return cleanup;
});

describe("Mermaid single-owner integration", () => {
  test("keeps embedded and native owners isolated, source-first and reload-stable", async () => {
    const { note, paragraph } = addParagraph();
    editor.mode = "page";
    await editor.updateComplete;
    const embeddedInsert = await insertEmbedded(paragraph);
    const embedded = getMermaidBlock(embeddedInsert.blockId);
    const embeddedIds = [...embedded.childIds];
    const embeddedNodeId = embeddedInsert.shapeIds[0]!;
    const embeddedNodeBound = modelBound(embeddedNodeId);

    editor.mode = "edgeless";
    await editor.updateComplete;
    const nativeInsert = await insertNative();
    const native = getMermaidBlock(nativeInsert.blockId);
    const surface = getSurface();

    expect(doc.getParent(embedded)?.id).toBe(note.id);
    expect(doc.getParent(native)?.id).toBe(surface.id);
    expect(embedded.childIds).toEqual(embeddedInsert.elementIds);
    expect(native.childIds).toEqual(nativeInsert.elementIds);
    expect(new Set([...embedded.childIds, ...native.childIds]).size).toBe(
      embedded.childIds.length + native.childIds.length,
    );

    const embeddedProjection = resolveMermaidGfxProjection(embedded)!;
    const embeddedQuery = createMermaidOwnerGfxQuery(embeddedProjection);
    const embeddedQueryIds = embeddedQuery.match.map((entry) => entry.id);
    expect(embeddedQueryIds).toEqual([
      surface.id,
      embedded.id,
      ...embedded.childIds,
    ]);
    const rootExclusions = collectEmbeddedMermaidRootExclusions(doc);
    expect([...embedded.childIds].every((id) => rootExclusions.has(id))).toBe(
      true,
    );
    expect([...native.childIds].some((id) => rootExclusions.has(id))).toBe(
      false,
    );
    const rootVisibleIds = surface.elementModels
      .map(({ id }) => id)
      .filter((id) => !rootExclusions.has(id));
    expect(embedded.childIds.some((id) => rootVisibleIds.includes(id))).toBe(
      false,
    );
    expect(native.childIds.every((id) => rootVisibleIds.includes(id))).toBe(
      true,
    );

    const parsed = parseMermaidSourceToGfxVisualModel(FLOWCHART_SOURCE);
    if (!parsed.model) throw new Error("Flowchart fixture must parse");
    const editable = getMermaidSourceAuthoritativeVisualModel(
      getHost().std,
      embedded,
    );
    if (!editable)
      throw new Error("Embedded fixture must have a live projection");
    const renamed = renameMermaidVisualNode(editable, "A", "Ready");
    const [renameOk, renameContext] = getHost().std.command.exec(
      applyMermaidVisualModelCommand,
      { model: embedded, visualModel: renamed },
    );
    expect(renameOk).toBe(true);
    expect(renameContext.applied).toBe(true);
    expect(embedded.childIds).toEqual(embeddedIds);
    expect(modelBound(embeddedNodeId)).toBe(embeddedNodeBound);
    expect(getMermaidBlockSource(embedded.props)).toContain("A[Ready]");

    const topology = parseMermaidSourceToGfxVisualModel(
      "flowchart TD\n  A[Ready] --> D[Ship]",
    );
    if (!topology.model) throw new Error("Topology fixture must parse");
    const removedIds = embeddedIds.filter((id) => id !== embeddedNodeId);
    const [topologyOk, topologyContext] = getHost().std.command.exec(
      applyMermaidVisualModelCommand,
      {
        model: embedded,
        visualModel: preserveMermaidProjectionOwnerGeometry(
          doc,
          embedded,
          topology.model,
        ),
      },
    );
    expect(topologyOk).toBe(true);
    expect(topologyContext.applied).toBe(true);
    expect(embedded.childIds).toContain(embeddedNodeId);
    expect(modelBound(embeddedNodeId)).toBe(embeddedNodeBound);
    expect(removedIds.every((id) => !surface.hasElementById(id))).toBe(true);
    const topologyConnectorIds = ownerConnectorIds(embedded);
    expect(topologyConnectorIds.length).toBeGreaterThan(0);
    for (const connectorId of topologyConnectorIds) {
      expect(
        connectorEndpoints(connectorId).every((id) =>
          embedded.childIds.includes(id!),
        ),
      ).toBe(true);
    }

    const nativeParent = doc.getParent(native)?.id;
    const nativeIds = [...native.childIds];
    const nativeBounds = nativeIds.map(modelBound);
    const lastValidSource = native.props.lastValidSource;
    const noteCount = doc.getBlocksByFlavour("myoxus:note").length;
    writeMermaidSourceModelState(native, PIE_SOURCE);
    const [blockedOk, blockedContext] = getHost().std.command.exec(
      applyMermaidVisualModelCommand,
      { model: native, visualModel: parsed.model },
    );
    expect(blockedOk).toBe(true);
    expect(blockedContext.applied).toBe(false);
    expect(blockedContext.diagnostic).toBeDefined();
    expect(getMermaidBlockSource(native.props)).toBe(PIE_SOURCE);
    expect(native.props.lastValidSource).toBe(lastValidSource);
    expect(doc.getParent(native)?.id).toBe(nativeParent);
    expect(doc.getBlocksByFlavour("myoxus:note")).toHaveLength(noteCount);
    expect(native.childIds).toEqual(nativeIds);
    expect(nativeIds.map(modelBound)).toEqual(nativeBounds);

    writeMermaidSourceModelState(native, lastValidSource ?? FLOWCHART_SOURCE);
    // Source parsing starts with fresh layout coordinates. Restore the live
    // owner's geometry before applying it, as the source reconciliation does.
    const [restoreOk, restoreContext] = getHost().std.command.exec(
      applyMermaidVisualModelCommand,
      {
        model: native,
        visualModel: preserveMermaidProjectionOwnerGeometry(
          doc,
          native,
          parsed.model,
        ),
      },
    );
    expect(restoreOk).toBe(true);
    expect(restoreContext.applied).toBe(true);
    expect(doc.getParent(native)?.id).toBe(nativeParent);
    expect(native.childIds).toEqual(nativeIds);
    expect(nativeIds.map(modelBound)).toEqual(nativeBounds);

    const reloaded = collection
      .getDoc("doc:home")
      ?.getStore({ id: "mermaid-owner-reload" });
    if (!reloaded) throw new Error("Cannot create reloaded Mermaid store");
    const reloadedEmbedded = reloaded.getBlock(embedded.id)
      ?.model as MermaidBlockModel;
    const reloadedNative = reloaded.getBlock(native.id)
      ?.model as MermaidBlockModel;
    const reloadedSurface = getSurfaceBlock(reloaded);
    if (!reloadedSurface) throw new Error("Reloaded surface is unavailable");
    expect(reloaded.getParent(reloadedEmbedded)?.id).toBe(note.id);
    expect(reloaded.getParent(reloadedNative)?.id).toBe(nativeParent);
    expect(reloadedEmbedded.childIds).toEqual(embedded.childIds);
    expect(reloadedNative.childIds).toEqual(nativeIds);
    expect(
      nativeIds.map(
        (id) =>
          (reloadedSurface.getElementById(id) as { xywh?: string } | null)
            ?.xywh ?? null,
      ),
    ).toEqual(nativeBounds);
  });

  test("migrates legacy owners deterministically and remaps one clipboard payload once", async () => {
    // Inspect the planner's pre-write decisions independently of the automatic
    // permission watcher, which has its own consuming regression below.
    doc.get(MermaidOwnerMigrationExtension).disposed();
    const visible = addParagraph(NoteDisplayMode.DocAndEdgeless);
    const visibleInsert = await insertEmbedded(visible.paragraph);
    const visibleOwner = getMermaidBlock(visibleInsert.blockId);
    const visibleLegacy = makeLegacyLinkedOwner(
      visibleOwner,
      "[220,160,520,360]",
    );

    const technical = addParagraph(NoteDisplayMode.DocOnly);
    const technicalInsert = await insertEmbedded(technical.paragraph);
    doc.deleteBlock(technical.paragraph);
    const technicalOwner = getMermaidBlock(technicalInsert.blockId);
    const technicalLegacy = makeLegacyLinkedOwner(
      technicalOwner,
      "[900,220,520,360]",
    );

    const structured = addParagraph(NoteDisplayMode.DocOnly);
    const structuredInsert = await insertEmbedded(
      structured.paragraph,
      PIE_SOURCE,
    );
    doc.deleteBlock(structured.paragraph);
    const structuredOwner = getMermaidBlock(structuredInsert.blockId);
    structuredOwner.yBlock.set("prop:reference", "legacy-structured-owner");

    const retained = addParagraph(NoteDisplayMode.DocOnly);
    const retainedInsert = await insertEmbedded(retained.paragraph);
    const retainedOwner = getMermaidBlock(retainedInsert.blockId);
    const retainedLegacy = makeLegacyLinkedOwner(
      retainedOwner,
      "[1500,300,520,360]",
    );
    setMermaidBlockText(retainedOwner, "source", "flowchart TD\n  A[broken");
    retainedOwner.props.lastValidSource = "flowchart TD\n  A[broken";

    const beforeReadonly = encodeStateAsUpdate(doc.spaceDoc);
    doc.readonly = true;
    const readonlyPlan = planLinkedMermaidOwnerMigration(doc);
    expect(readonlyPlan.hasWrites).toBe(false);
    expect(
      readonlyPlan.decisions.every(
        (decision) =>
          decision.kind === "retain" && decision.code === "readonly",
      ),
    ).toBe(true);
    readonlyPlan.applyPlan();
    expect(encodeStateAsUpdate(doc.spaceDoc)).toEqual(beforeReadonly);
    const visibleLegacyProjections = [
      visibleOwner,
      technicalOwner,
      structuredOwner,
      retainedOwner,
    ].filter((owner) => {
      const parent = doc.getParent(owner);
      return (
        parent?.flavour === "myoxus:note" &&
        parent.props.displayMode === NoteDisplayMode.DocAndEdgeless &&
        resolveMermaidGfxProjection(owner)?.kind === "legacy"
      );
    });
    expect(visibleLegacyProjections.map(({ id }) => id)).toEqual([
      visibleOwner.id,
    ]);

    doc.readonly = false;
    const firstPlan = planLinkedMermaidOwnerMigration(doc);
    const independentlyInventoriedPlan = planLinkedMermaidOwnerMigration(doc);
    expect(migrationTargetIds(firstPlan)).toEqual(
      migrationTargetIds(independentlyInventoriedPlan),
    );
    expect(firstPlan.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "retain", code: "unresolved-source" }),
      ]),
    );
    firstPlan.applyPlan();

    expect(visibleOwner.yBlock.get("prop:reference")).toBeUndefined();
    expect(visibleOwner.childIds).toEqual(visibleLegacy.childIds);
    expect(doc.getParent(visibleOwner)?.id).toBe(visible.note.id);
    expect(doc.getBlock(visibleLegacy.frame.id)).toBeUndefined();

    expect(technicalOwner.yBlock.get("prop:reference")).toBeUndefined();
    expect(technicalOwner.childIds).toEqual(technicalLegacy.childIds);
    expect(doc.getParent(technicalOwner)?.id).toBe(getSurface().id);
    expect(doc.getBlock(technical.note.id)).toBeUndefined();
    expect(doc.getBlock(technicalLegacy.frame.id)).toBeUndefined();

    expect(structuredOwner.yBlock.get("prop:reference")).toBeUndefined();
    expect(doc.getParent(structuredOwner)?.id).toBe(structured.note.id);
    expect(structured.note.props.displayMode).toBe(
      NoteDisplayMode.DocAndEdgeless,
    );

    expect(retainedOwner.yBlock.get("prop:reference")).toBe(
      retainedLegacy.frame.id,
    );
    expect(doc.getBlock(retainedLegacy.frame.id)).toBeDefined();
    const idempotentPlan = planLinkedMermaidOwnerMigration(doc);
    expect(idempotentPlan.hasWrites).toBe(false);
    expect(idempotentPlan.decisions).toEqual([
      expect.objectContaining({
        code: "unresolved-source",
        kind: "retain",
        ownerId: retainedOwner.id,
      }),
    ]);

    writeMermaidSourceModelState(retainedOwner, FLOWCHART_SOURCE);
    const firstSafePlan = planLinkedMermaidOwnerMigration(doc);
    expect(firstSafePlan.hasWrites).toBe(true);
    expect(firstSafePlan.decisions).toEqual([
      expect.objectContaining({
        kind: "migrate",
        plan: expect.objectContaining({ owner: retainedOwner }),
      }),
    ]);
    firstSafePlan.applyPlan();
    expect(retainedOwner.yBlock.get("prop:reference")).toBeUndefined();
    expect(retainedOwner.childIds).toEqual(retainedLegacy.childIds);
    expect(doc.getBlock(retainedLegacy.frame.id)).toBeUndefined();
    expect(planLinkedMermaidOwnerMigration(doc).hasWrites).toBe(false);

    const payload = createMermaidClipboardPayloadV2(visibleOwner);
    expect(payload).not.toBeNull();
    const originalIds = payload!.elements.map((element) => element.id);
    const pasted = pasteMermaidClipboardPayloadV2({
      payload: payload!,
      std: getHost().std,
      targetModel: visibleOwner,
    });
    expect(pasted).not.toBeNull();
    expect(visibleOwner.childIds).toEqual(originalIds);
    expect(new Set(getMermaidBlock(pasted!.blockId).childIds)).toEqual(
      new Set(pasted!.elementIds),
    );
    expect(pasted!.elementIds).toHaveLength(originalIds.length);
    expect(pasted!.elementIds.every((id) => !originalIds.includes(id))).toBe(
      true,
    );
    expect(new Set(pasted!.elementIds).size).toBe(pasted!.elementIds.length);
    for (const connectorId of pasted!.connectorIds) {
      expect(
        connectorEndpoints(connectorId).every((id) =>
          pasted!.elementIds.includes(id!),
        ),
      ).toBe(true);
    }
  });

  test("migrates once when a mounted legacy owner becomes writable", async () => {
    const { paragraph } = addParagraph();
    const inserted = await insertEmbedded(paragraph);
    const owner = getMermaidBlock(inserted.blockId);
    const legacy = makeLegacyLinkedOwner(owner, "[220,160,520,360]");
    doc.readonly = true;
    const beforeReadonly = encodeStateAsUpdate(doc.spaceDoc);
    expect(planLinkedMermaidOwnerMigration(doc).hasWrites).toBe(false);
    expect(encodeStateAsUpdate(doc.spaceDoc)).toEqual(beforeReadonly);

    doc.readonly = false;
    await wait();
    expect(owner.yBlock.get("prop:reference")).toBeUndefined();
    expect(owner.childIds).toEqual(legacy.childIds);
    expect(doc.getBlock(legacy.frame.id)).toBeUndefined();
    // Migration replaces the rendered owner. Wait for the Note mask's existing
    // ResizeObserver/rAF projection before comparing whole-document idempotence.
    const note = doc.getParent(owner) as NoteBlockModel;
    await expect
      .poll(() => {
        const view = getHost().view.getBlock(note.id);
        const mask = view?.querySelector(".myoxus-note-mask");
        const zoom = getHost().std.get(GfxControllerIdentifier).viewport.zoom;
        const visual = getMermaidSourceAuthoritativeVisualModel(
          getHost().std,
          owner,
        );
        return Boolean(
          mask &&
          visual &&
          resolveMermaidProjectionOwnerBoundForVisualModel(
            owner,
            visual,
            visual,
          ).serialize() === owner.xywh &&
          almostEqual(
            Bound.deserialize(note.xywh).h,
            mask.getBoundingClientRect().height / zoom,
          ),
        );
      })
      .toBe(true);
    const migrated = encodeStateAsUpdate(doc.spaceDoc);
    doc.readonly = true;
    doc.readonly = false;
    await wait();
    expect(encodeStateAsUpdate(doc.spaceDoc)).toEqual(migrated);
  });
});
