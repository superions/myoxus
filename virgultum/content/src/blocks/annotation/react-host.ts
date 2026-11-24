// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/core/primitives/di";
import type { ExtensionType } from "@virgultum/core/store";
import type { ReadonlySignal } from "@preact/signals-core";

export type AnnotationBlockHostProps = {
  body: string;
  readonly: boolean;
  editRequest: number;
  /** Reject a stale draft at the write boundary, not only at React render time. */
  apply: (body: string, expectedBody: string) => boolean;
};
export type AnnotationReactHost = {
  showAnnotations: boolean;
  mountBlock: (
    anchor: HTMLElement,
    props: ReadonlySignal<AnnotationBlockHostProps>,
  ) => () => void;
  mountInline?: (
    anchor: HTMLElement,
    props: ReadonlySignal<AnnotationInlineHostProps | undefined>,
  ) => () => void;
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
