// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/core/primitives/di";
import type { ExtensionType } from "@virgultum/core/store";
import type { BpmnPreviewArtifact } from "@virgultum/core/models";

export type BpmnBlockPresentationProps = {
  docId: string;
  title: string;
  /** Unformatted block Text; input must not consume the display fallback. */
  titleValue: string;
  readonly: boolean;
  sourceState: "ready" | "conflict" | "error";
  sourceRevision: string | null;
  preview: BpmnPreviewArtifact | null;
  previewErrorRevision: string | null;
  loadPreview(sourceId: string): Promise<Blob | null>;
  downloads: ReadonlyArray<{ revision: string; download(): void }>;
  onTitleChange(value: string): void;
  onOpen(): Promise<void>;
  onRetry(): Promise<void>;
};
export type BpmnBlockPresentationBinding = {
  getSnapshot(): BpmnBlockPresentationProps;
  subscribe(listener: () => void): () => void;
};

type MountBpmnPresentation = (
  anchor: HTMLElement,
  binding: BpmnBlockPresentationBinding,
) => () => void;

/** The block projects persisted state into the existing React provider tree. */
export const BpmnBlockPresentationIdentifier = createIdentifier<{
  mount: MountBpmnPresentation;
}>("BpmnBlockPresentation");
export function BpmnBlockPresentationExtension(
  mount: MountBpmnPresentation,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(BpmnBlockPresentationIdentifier, () => ({ mount }));
    },
  };
}
