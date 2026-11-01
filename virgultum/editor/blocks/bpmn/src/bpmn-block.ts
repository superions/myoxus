// SPDX-License-Identifier: AGPL-3.0-or-later
import { inspectBpmnSource } from "@myoxus/bpmn-editor/source";
import type { BpmnBlockModel } from "@virgultum/model";
import { EditorI18nProvider } from "@virgultum/shared/services";
import { downloadBlob } from "@virgultum/shared/utils";
import { BlockComponent } from "@virgultum/std";
import { css } from "lit";
import * as Y from "yjs";
import {
  BpmnBlockPresentationIdentifier,
  type BpmnBlockPresentationProps,
} from "./presentation.js";
import { readBpmnSourceRevisions } from "./source-revisions.js";
import { getBpmnBlockTitle, setBpmnBlockTitle } from "./utils.js";
import { requestBpmnEditor } from "./session-request.js";

/** Native notes own canvas masks, selection, movement and resize. The
 * presentation's Edit/Open action and Page preview double-click request this
 * one shared full-screen session; rendering alone never repairs source. */
export class BpmnBlockComponent extends BlockComponent<BpmnBlockModel> {
  static override styles = css`
    myoxus-bpmn {
      display: block;
    }
  `;
  private _inspection?: { source: string; accepted: boolean };
  override connectedCallback() {
    super.connectedCallback();
    this.contentEditable = "false";
    this.tabIndex = 0;
    const update = () => this.requestUpdate();
    this.model.yBlock.observeDeep(update);
    this._disposables.add(() => this.model.yBlock.unobserveDeep(update));
  }
  private readonly _open = async () => {
    await requestBpmnEditor(this.std, this.blockId);
  };
  private _download(revision: string) {
    const heads = this.model.yBlock.get("prop:sourceHeads");
    const source = heads instanceof Y.Map ? heads.get(revision) : undefined;
    if (typeof source !== "string")
      throw new Error("BPMN_REVISION_MISSING_SOURCE");
    downloadBlob(
      new Blob([source], { type: "application/xml;charset=utf-8" }),
      `BPMN-${this.blockId}-${revision}.bpmn`,
    );
  }
  override render() {
    let sourceState: BpmnBlockPresentationProps["sourceState"] = "error";
    let sourceRevision: string | null = null;
    try {
      const state = readBpmnSourceRevisions(this.model.yBlock);
      if (state.status === "conflict") sourceState = "conflict";
      else if (state.selected) {
        sourceRevision = state.selected;
        const source = state.heads.get(state.selected)!;
        if (this._inspection?.source !== source)
          this._inspection = {
            source,
            accepted: inspectBpmnSource(source).status === "accepted",
          };
        sourceState = this._inspection.accepted ? "ready" : "error";
      }
    } catch {
      sourceState = "error";
    }
    const rawHeads = this.model.yBlock.get("prop:sourceHeads");
    const rawPreview = this.model.props.preview;
    const preview =
      rawPreview &&
      typeof rawPreview.revision === "string" &&
      typeof rawPreview.sourceId === "string" &&
      rawPreview.sourceId
        ? rawPreview
        : null;
    const downloads =
      rawHeads instanceof Y.Map
        ? [...rawHeads]
            .filter(([, value]) => typeof value === "string")
            .map(([revision]) => ({
              revision,
              download: () => this._download(revision),
            }))
        : [];
    return this.std.get(BpmnBlockPresentationIdentifier).render({
      docId: this.store.id,
      title: getBpmnBlockTitle(
        this.model.props,
        this.std.getOptional(EditorI18nProvider) ?? undefined,
      ),
      titleValue: this.model.props.title.toString(),
      readonly: this.store.readonly,
      sourceState,
      sourceRevision,
      preview,
      previewErrorRevision:
        typeof this.model.props.previewErrorRevision === "string"
          ? this.model.props.previewErrorRevision
          : null,
      loadPreview: (sourceId) => this.store.blobSync.get(sourceId),
      downloads,
      onTitleChange: (value) => setBpmnBlockTitle(this.model, value),
      onOpen: this._open,
      onRetry: this._open,
    });
  }
}
