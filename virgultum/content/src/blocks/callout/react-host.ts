// SPDX-License-Identifier: AGPL-3.0-or-later
import { createIdentifier } from "@virgultum/core/primitives/di";
import type { ExtensionType } from "@virgultum/core/store";
import type { ReadonlySignal } from "@preact/signals-core";
import type { IconData } from "@virgultum/core/services";

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
type CalloutHost = {
  mountTitle(
    anchor: HTMLElement,
    state: ReadonlySignal<CalloutTitleHostProps>,
  ): () => void;
  mountIcon(
    anchor: HTMLElement,
    state: ReadonlySignal<IconData | undefined>,
  ): () => void;
};
export const CalloutTitleHostIdentifier =
  createIdentifier<CalloutHost>("CalloutTitleHost");
export function CalloutTitleHostExtension(host: CalloutHost): ExtensionType {
  return { setup: (di) => di.addImpl(CalloutTitleHostIdentifier, () => host) };
}
