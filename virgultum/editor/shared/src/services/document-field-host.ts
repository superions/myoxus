// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { TemplateResult } from "lit";
import type { DocumentField } from "../types/document-field";

/** The host projects one native occurrence; the Y.Text descriptor remains the
 * only editable source. Historical runs never enter this live-field host.
 */
export interface DocumentFieldInlineHostProps {
  field: DocumentField;
  readonly: boolean;
  /** Fixed owner structure forbids removal/conversion, not canonical answers. */
  textProtected?: boolean;
  /** Replace this exact still-current atom, retaining its authored marks. */
  convertToText: (expected: DocumentField, text: string) => boolean;
  /** Change only a still-current source input definition, never its identity or answer. */
  updateDefinition: (
    expected: DocumentField,
    replacement: DocumentField,
  ) => boolean;
  /** Commit only this still-current input occurrence, retaining its definition. */
  updateValue: (expected: DocumentField, replacement: DocumentField) => boolean;
  focusEditor: (side: "before" | "after") => void;
}

export interface DocumentFieldReactHost {
  renderInline(props: DocumentFieldInlineHostProps): TemplateResult;
}

export const DocumentFieldReactHostIdentifier =
  createIdentifier<DocumentFieldReactHost>("DocumentFieldReactHost");
