// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";

export type AnnotationBlockHostProps = {
  body: string;
  readonly: boolean;
  editRequest: number;
  /** Reject a stale draft at the write boundary, not only at React render time. */
  apply: (body: string, expectedBody: string) => boolean;
};
export type AnnotationReactHost = {
  showAnnotations: boolean;
  renderBlock: (props: AnnotationBlockHostProps) => TemplateResult;
  renderInline?: (props: AnnotationInlineHostProps) => TemplateResult;
};
export type AnnotationInlineHostProps = {
  id: string;
  body: string;
  readonly: boolean;
  apply: (body: string, expectedBody: string) => boolean;
  remove: (expectedBody: string) => boolean;
  focusEditor: (side: "before" | "after") => void;
};
export const AnnotationReactHostIdentifier =
  createIdentifier<AnnotationReactHost>("AnnotationReactHost");
export function AnnotationReactHostExtension(
  host: AnnotationReactHost,
): ExtensionType {
  return {
    setup: (di) => di.addImpl(AnnotationReactHostIdentifier, () => host),
  };
}
