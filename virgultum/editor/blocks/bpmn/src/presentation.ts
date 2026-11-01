// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";
import type { BpmnPreviewArtifact } from "@virgultum/model";

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
/** The block observes persisted state; the existing Core portal owns all visible controls. */
export const BpmnBlockPresentationIdentifier = createIdentifier<{
  render(props: BpmnBlockPresentationProps): TemplateResult;
}>("BpmnBlockPresentation");
export function BpmnBlockPresentationExtension(
  render: (props: BpmnBlockPresentationProps) => TemplateResult,
): ExtensionType {
  return {
    setup: (di) => {
      di.addImpl(BpmnBlockPresentationIdentifier, () => ({ render }));
    },
  };
}
