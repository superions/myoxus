// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Types and capability enum for the Myoxus Host Service.
 *
 * The Host Service is the typed boundary between Virgultum (editor core)
 * and the Myoxus application shell. It replaces the previous DOM
 * `CustomEvent` and `globalThis.currentEditor` coupling with explicit,
 * versioned service methods.
 *
 * @see docs/dev/virgultum/refactor-roadmap.md §B (P-VIRG-ARCH-B)
 */

import type { EditorI18nMessage, EditorI18nService } from "../i18n-service.js";

/**
 * Capabilities that a `MyoxusHostService` may expose. The service
 * implementation advertises a set of capabilities; consumers MUST
 * check `capabilities.has(...)` before invoking a method, or
 * catch the `MyoxusHostBindingError` thrown by the null binding.
 */
export const MyoxusHostCapability = {
  OpenEventEditDialog: "open-event-edit-dialog",
  ResolveEventData: "resolve-event-data",
  ConfirmEventBlockRemoval: "confirm-event-block-removal",
  ImageProxyUrl: "image-proxy-url",
  FeatureFlags: "feature-flags",
  WorkspaceContext: "workspace-context",
  BpmnEditorSession: "bpmn-editor-session",
} as const;

export type MyoxusHostCapability =
  (typeof MyoxusHostCapability)[keyof typeof MyoxusHostCapability];

/**
 * Loosely-typed capability set used by service constructors that
 * accept the set as a parameter (e.g. `createMyoxusHostService`).
 * Accepts arrays and iterables to make JS interop ergonomic.
 */
export type MyoxusCapabilitySetLike =
  ReadonlySet<MyoxusHostCapability> | Iterable<MyoxusHostCapability>;

export type MyoxusTemplateVariableGroup =
  "document" | "workspace" | "date" | "context" | "actor";

/** Host-projected authoring data. Resolution remains owned by Core/server. */
export type MyoxusTemplateVariableCapability = {
  name: string;
  group: MyoxusTemplateVariableGroup;
  label: EditorI18nMessage;
  source: EditorI18nMessage;
  availability: EditorI18nMessage;
};

/** Selection is captured by the editor; write access is rechecked on commit. */
export type MyoxusTemplateVariableRequest = {
  i18n?: EditorI18nService;
  canWrite: () => boolean;
  insert: (token: string) => void;
  /** Restore the source selection after the chooser has released focus. */
  onClose: () => void;
};

/**
 * Host-neutral event data used by the editor renderer.
 */
export type MyoxusResolvedEvent = {
  title: string;
  startsAt?: string;
  endsAt?: string;
  allDay?: boolean;
  tagColor?: string | null;
};

/**
 * Open the event edit dialog. Returns the new (or updated) eventId, or
 * `null` if the user cancelled the dialog.
 */
export type MyoxusOpenEventEditDialogArgs = {
  eventId?: string;
  sourceDocId?: string;
  workspaceId?: string;
};

/**
 * Resolve a workspace event by its stable id.
 */
export type MyoxusResolveEventRequest = {
  eventId: string;
  workspaceId: string;
};

/**
 * Block-removal confirmation. The host may veto the removal by returning
 * `false`; the block MUST NOT delete itself in that case.
 */
export type MyoxusConfirmEventRemovalRequest = {
  blockId: string;
  eventId: string;
  workspaceId: string;
};

/** One document/block session in the existing workspace dialog host; no persisted edit lock. */
export type MyoxusBpmnEditorRequest = {
  workspaceId: string;
  docId: string;
  blockId: string;
  editorHostId: string;
};
export type MyoxusBpmnEditorCloseResult = {
  status: "closed" | "discarded";
  revision: string | null;
};
