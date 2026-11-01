// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/global/di";
import type { ExtensionType } from "@virgultum/store";
import type { TemplateResult } from "lit";

export type CalloutTitleHostProps = {
  type?: string;
  foldable?: boolean;
  defaultOpen?: boolean;
  expanded?: boolean;
  toggle?: () => void;
  applySettings?: (value: {
    type: string;
    foldable: boolean;
    defaultOpen: boolean;
  }) => boolean;
  title: string;
  readonly: boolean;
  apply: (title: string, expectedTitle: string) => boolean;
  focusEditor: () => void;
};
export const CalloutTitleHostIdentifier = createIdentifier<{
  render: (props: CalloutTitleHostProps) => TemplateResult;
}>("CalloutTitleHost");
export function CalloutTitleHostExtension(
  render: (props: CalloutTitleHostProps) => TemplateResult,
): ExtensionType {
  return {
    setup: (di) => di.addImpl(CalloutTitleHostIdentifier, () => ({ render })),
  };
}
