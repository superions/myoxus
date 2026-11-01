// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";
import type { FootnotePlacement } from "@virgultum/model";
export type FootnoteMarkerHostProps = {
  label?: string;
  placement?: FootnotePlacement;
  number?: number;
  missing: boolean;
  navigate: () => void;
};
export type FootnoteHeaderHostProps = {
  titleId: string;
  placement?: FootnotePlacement;
  number?: number;
  readonly: boolean;
  canReturn: boolean;
  returnToMarker: () => void;
  remove: () => void;
  changePlacement: (placement: FootnotePlacement) => void;
};
export type FootnoteInsertionHostProps = {
  placement: FootnotePlacement;
  definitions: {
    id: string;
    placement?: FootnotePlacement;
    number?: number;
    excerpt: string;
  }[];
  choose: (id?: string) => void;
  cancel: () => void;
};
export type FootnoteReactHost = {
  renderInsertion: (props: FootnoteInsertionHostProps) => TemplateResult;
  renderMarker: (props: FootnoteMarkerHostProps) => TemplateResult;
  renderHeader: (props: FootnoteHeaderHostProps) => TemplateResult;
};
export const FootnoteReactHostIdentifier =
  createIdentifier<FootnoteReactHost>("FootnoteReactHost");
export function FootnoteReactHostExtension(
  host: FootnoteReactHost,
): ExtensionType {
  return { setup: (di) => di.addImpl(FootnoteReactHostIdentifier, () => host) };
}
