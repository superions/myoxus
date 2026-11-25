// SPDX-License-Identifier: AGPL-3.0-or-later

import { Service } from "@myoxus/infra";
import { BlockSelection, type BlockStdScope } from "@virgultum/editor/std";
import {
  Slice,
  Text,
  toDraftModel,
  fromJSON,
  toJSON,
  type DeltaInsert,
} from "@virgultum/editor/store";
import { encodeStateAsUpdate } from "yjs";

import {
  type BuildingBlockTarget,
  BuildingBlockTargetError,
  buildingBlockTargetStore,
  resolveBuildingBlockTarget,
} from "../../../editor/virgultum/doc-editor/building-block-target";
import { DocsService } from "../../doc";
import { removeUnboundTemplateReferences } from "../../doc/services/native-template-references";
import { createReadonlySnapshotWorkspace } from "../../doc/services/readonly-snapshot-workspace";
import { buildTemplateVariables } from "../../doc/services/template-variables";
import type { RegionalFormatPreferences } from "../../i18n";
import { FeatureFlagService } from "../../feature-flag";
import { GuardService } from "../../permissions";
import { WorkspaceService, WorkspacesService } from "../../workspace";
import { BuiltinTemplateReconcilerService } from "./builtin-reconciler";
import { TemplateDocService } from "./template-doc";
import {
  TemplateInstantiationError,
  waitForTemplateOperation,
} from "./template-instantiation-error";
import {
  templateInputLabel,
  initializeTemplateDocumentFields,
} from "./template-inputs";
import { applyNativeTemplateValues } from "./template-preparation";
import { captureTemplateSource } from "./template-source-capture";
import { prepareTemplateTextProtection } from "./template-text-protection";

export class TemplateSectionInsertionService extends Service {
  constructor(
    private readonly docs: DocsService,
    private readonly templates: TemplateDocService,
    private readonly guard: GuardService,
    private readonly workspaceService: WorkspaceService,
    private readonly featureFlags: FeatureFlagService,
    private readonly workspaces: WorkspacesService,
    private readonly builtins: BuiltinTemplateReconcilerService,
  ) {
    super();
  }

  /** Named commands resolve a delivered source, then use the same native writer
   * and revision fence as the Library picker. They never synthesize block bodies.
   */
  async insertNamed(
    slug: string,
    target: BuildingBlockTarget,
    preferences: RegionalFormatPreferences,
    signal: AbortSignal,
    onCommitted: () => void,
  ) {
    resolveBuildingBlockTarget(target);
    const sourceDocId =
      this.workspaceService.workspace.flavour === "local"
        ? (await this.builtins.ensureBuiltinTemplatesSeeded([slug]))[slug]
        : (
            await this.templates.lookupNamedBuildingBlock(
              slug,
              preferences.locale,
            )
          )?.templateDocId;
    if (!sourceDocId)
      throw new TemplateInstantiationError("source-unavailable");
    const source = this.docs.open(sourceDocId, { readonly: true });
    if (!source) throw new TemplateInstantiationError("source-unavailable");
    let revision: Uint8Array;
    try {
      await source.doc.waitForSyncReady(signal);
      revision = encodeStateAsUpdate(source.doc.yDoc);
    } finally {
      source.release();
    }
    await this.insert(
      sourceDocId,
      revision,
      target,
      preferences,
      signal,
      onCommitted,
    );
  }

  /** Preparation is fallible and read-only to live documents. The final native
   * write is synchronous and scoped to new section identities; confirmation
   * failure after that boundary never retries or removes a committed section.
   */
  async insert(
    sourceDocId: string,
    expectedRevision: Uint8Array,
    target: BuildingBlockTarget,
    preferences: RegionalFormatPreferences,
    signal: AbortSignal,
    onCommitted: () => void,
  ) {
    resolveBuildingBlockTarget(target);
    if (sourceDocId === target.docId)
      throw new TemplateInstantiationError("source-unavailable");
    await this.templates.resolveSourceMetadataForDoc(sourceDocId, signal);
    const sourceRef = this.docs.open(sourceDocId, { readonly: true });
    if (!sourceRef) throw new TemplateInstantiationError("source-unavailable");
    const workspace = this.workspaceService.workspace;
    const stage = createReadonlySnapshotWorkspace(
      workspace.id,
      this.featureFlags,
      this.workspaces.getWorkspaceFlavourProvider(workspace.meta),
    );
    const targetRef = this.docs.open(target.docId);
    try {
      if (!targetRef) throw new TemplateInstantiationError("cancelled");
      await waitForTemplateOperation(
        Promise.all([
          sourceRef.doc.waitForSyncReady(signal),
          targetRef.doc.waitForSyncReady(signal),
        ]),
        signal,
      );
      using transformer = this.docs.createDocTransformer(false);
      const source = captureTemplateSource(sourceRef, transformer);
      if (
        source.revision.length !== expectedRevision.length ||
        source.revision.some(
          (value, index) => value !== expectedRevision[index],
        )
      )
        throw new TemplateInstantiationError("conflict");
      const date = new Date();
      const variables = buildTemplateVariables(date, preferences);
      delete variables["calendar.iso_week_year"];
      const values = await this.docs.prepareTemplateVariables({
        sourceDocId,
        targetDocId: target.docId,
        creationContext: {},
        requested: source.inspection.required,
        repeats: source.inspection.repeats,
        variables,
        inputs: Object.fromEntries(
          source.inputNames.map((name) => [
            name,
            `[${templateInputLabel(name)}]`,
          ]),
        ),
        applicationDate: date,
        regionalPreferences: preferences,
        signal,
        deferCreation: false,
      });
      const detached = stage.loadSnapshot(sourceDocId, source.revision, {
        readonly: false,
      });
      if (applyNativeTemplateValues(detached, values).length)
        throw new TemplateInstantiationError("unresolved-variable");
      using bodyTransformer = detached.getTransformer();
      const models = (detached.root?.children ?? [])
        .filter((model) => model.flavour === "myoxus:note")
        .flatMap((note) => note.children);
      const body = bodyTransformer.sliceToSnapshot(
        Slice.fromModels(detached, models),
      );
      if (!body?.content.length)
        throw new TemplateInstantiationError("source-unavailable");
      removeUnboundTemplateReferences(body);
      initializeTemplateDocumentFields(body);
      prepareTemplateTextProtection(body, true);
      const placement = resolveBuildingBlockTarget(target);
      const targetDoc = buildingBlockTargetStore(target);
      let ephemeralStd: BlockStdScope | null = null;
      const stdForSlice =
        target.std ??
        (ephemeralStd = await (async () => {
          const [{ BlockStdScope }, { clipboardConfigs }] = await Promise.all([
            import("@virgultum/core/runtime"),
            import("@virgultum/editor/foundation/clipboard"),
          ]);
          return new BlockStdScope({
            store: targetDoc,
            extensions: [...clipboardConfigs],
          });
        })());
      const prepared = await stdForSlice.clipboard.prepareNativeSlice(
        body,
        targetDoc,
        placement.note.id,
      );
      try {
        const [canWrite, metadata] = await waitForTemplateOperation(
          Promise.all([
            this.guard.can("Doc_Update", target.docId),
            this.templates.resolveSourceMetadataForDoc(sourceDocId, signal),
          ]),
          signal,
        );
        const current = encodeStateAsUpdate(sourceRef.doc.yDoc);
        if (
          metadata?.category !== "building-blocks" ||
          sourceRef.doc.trash$.value ||
          !sourceRef.doc.isTemplate$.value
        )
          throw new TemplateInstantiationError("source-unavailable");
        if (!canWrite) throw new BuildingBlockTargetError("readonly");
        if (
          current.length !== source.revision.length ||
          current.some((value, index) => value !== source.revision[index])
        )
          throw new TemplateInstantiationError("conflict");
        signal.throwIfAborted();
        const inserted = commitBuildingBlockSection(target, prepared, signal);
        onCommitted();
        if (target.std) {
          target.std.selection.setGroup(
            "note",
            inserted.content.map(
              (block) => new BlockSelection({ blockId: block.id }),
            ),
          );
        } else {
          const firstTextBlock = inserted.content.find((block) => block.text);
          if (firstTextBlock) target.restoreFocus?.(firstTextBlock.id, 0);
        }
        await waitForTemplateOperation(
          workspace.engine.doc.waitForSynced(target.docId, signal),
          signal,
        );
      } finally {
        prepared.dispose();
        ephemeralStd?.unmount();
      }
    } finally {
      stage.dispose();
      sourceRef.release();
      targetRef?.release();
    }
  }
}

/** One synchronous history unit for a native section and its optional paragraph
 * split. Compensation touches only new IDs and the removed native text tail. */
export function commitBuildingBlockSection(
  target: BuildingBlockTarget,
  prepared: Pick<
    Awaited<ReturnType<BlockStdScope["clipboard"]["prepareNativeSlice"]>>,
    "assertCurrent" | "snapshot" | "commit"
  >,
  signal: AbortSignal,
): Slice {
  const anchor = resolveBuildingBlockTarget(target);
  signal.throwIfAborted();
  prepared.assertCurrent();
  const doc = buildingBlockTargetStore(target);
  const paragraph =
    anchor.block.flavour === "myoxus:paragraph" ? anchor.block : null;
  const caret = paragraph?.text && anchor.caret !== null ? anchor.caret : null;
  // Capture the final text only after all awaits. The tail retains native
  // marks and paragraph properties; synchronous commit cannot interleave
  // another local or remote edit with this split.
  const tail =
    paragraph?.text &&
    caret !== null &&
    caret > 0 &&
    caret < paragraph.text.length
      ? {
          id: doc.workspace.idGenerator(),
          delta: paragraph.text.sliceToDelta(caret),
          props: fromJSON(toJSON(toDraftModel(paragraph).props)) as Record<
            string,
            unknown
          >,
        }
      : null;
  const tailText = tail ? new Text(tail.delta as DeltaInsert[]) : null;
  const index =
    caret === 0 && paragraph?.text?.length ? anchor.index : anchor.index + 1;
  let split = false;
  doc.captureSync();
  let inserted: ReturnType<typeof prepared.commit>;
  try {
    if (tail && paragraph?.text && caret !== null) {
      paragraph.text.delete(caret, paragraph.text.length - caret);
      split = true;
    }
    inserted = prepared.commit(index, (write) => {
      signal.throwIfAborted();
      resolveBuildingBlockTarget(target);
      write();
    });
    if (tail) {
      doc.addBlock(
        "myoxus:paragraph",
        { ...tail.props, id: tail.id, text: tailText },
        anchor.note.id,
        index + inserted.content.length,
      );
      if (
        doc.getModelById(tail.id)?.text?.toString() !==
        tail.delta.map((delta) => delta.insert ?? "").join("")
      )
        throw new Error("Native paragraph split failed");
    }
  } catch (error) {
    // No asynchronous yield occurs during commit. Compensate only IDs
    // allocated for this section, never a previous document snapshot.
    try {
      for (const id of [
        ...prepared.snapshot.content.map((block) => block.id),
        ...(tail ? [tail.id] : []),
      ].reverse()) {
        const model = doc.getModelById(id);
        if (model) doc.deleteBlock(model);
      }
      if (split && paragraph?.text && caret !== null && tail)
        paragraph.text.applyDelta([{ retain: caret }, ...tail.delta]);
    } catch (cause) {
      throw new TemplateInstantiationError("rollback-failed", {
        cause,
        targetDocId: target.docId,
      });
    }
    throw error;
  } finally {
    doc.captureSync();
  }
  return inserted;
}
