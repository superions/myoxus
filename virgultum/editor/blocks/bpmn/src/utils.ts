// SPDX-License-Identifier: AGPL-3.0-or-later
import type { BpmnBlockModel } from "@virgultum/model";
import {
  editorMessage,
  resolveEditorMessage,
  type EditorI18nService,
} from "@virgultum/shared/services";

export type BpmnBlockSnapshotLike = { title?: unknown; caption?: unknown };
export function coerceBpmnBlockText(value: unknown) {
  if (typeof value === "string") return value.trim();
  // Native Transformer snapshots serialize Text as deltas. Export adapters must
  // retain that title without treating formatting or embeds as executable data.
  if (
    value &&
    typeof value === "object" &&
    "delta" in value &&
    Array.isArray(value.delta)
  ) {
    return value.delta
      .map((entry) => (typeof entry?.insert === "string" ? entry.insert : ""))
      .join("")
      .trim();
  }
  if (value && typeof value === "object" && "toString" in value) {
    if ("length" in value && value.length === 0) return "";
    const result = value.toString().trim();
    return result === "[object Object]" ? "" : result;
  }
  return "";
}
export function getBpmnBlockTitle(
  props: BpmnBlockSnapshotLike,
  i18n?: EditorI18nService,
) {
  return (
    coerceBpmnBlockText(props.title) ||
    resolveEditorMessage(
      editorMessage("com.myoxus.editor.bpmn.default-title", "BPMN Diagram"),
      i18n,
    )
  );
}
/** Block title only. Process name and containing-document title are separate authoring scopes. */
export function setBpmnBlockTitle(model: BpmnBlockModel, title: string) {
  if (model.store.readonly) return;
  const value = title.replaceAll("\r\n", "\n");
  if (model.props.title.toString() === value) return;
  model.store.transact(() => {
    model.props.title.delete(0, model.props.title.length);
    model.props.title.insert(value, 0);
  });
}
export function getBpmnBlockExportLabel(props: BpmnBlockSnapshotLike) {
  return `BPMN: ${getBpmnBlockTitle(props)}`;
}
export function getBpmnBlockExportMetadata(props: BpmnBlockSnapshotLike) {
  return {
    title: getBpmnBlockTitle(props),
    label: getBpmnBlockExportLabel(props),
  };
}
export function isBpmnBlockModel(value: unknown): value is BpmnBlockModel {
  return Boolean(
    value &&
    typeof value === "object" &&
    "flavour" in value &&
    value.flavour === "myoxus:bpmn",
  );
}
