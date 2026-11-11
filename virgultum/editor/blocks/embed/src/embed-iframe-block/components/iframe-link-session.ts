// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import type { EmbedIframeBlockModel } from "@virgultum/model";
import {
  EditorChromeHostIdentifier,
  mountInlinePopup,
} from "@virgultum/shared/services";
import type { BlockStdScope } from "@virgultum/std";
import { EmbedIframeLinkInputBase } from "./embed-iframe-link-input-base";

export type EmbedLinkInputPopupOptions = {
  showCloseButton?: boolean;
  variant?: "default" | "mobile";
  title?: string;
  description?: string;
  placeholder?: string;
  telemetrySegment?: string;
};

/** The block owns the command and lifetime; Mantine owns the form and positioning. */
export function openIframeLinkEditor(
  std: BlockStdScope,
  model: EmbedIframeBlockModel,
  anchor: HTMLElement,
  abort: AbortController,
  inSurface: boolean,
  editing: boolean,
  options?: EmbedLinkInputPopupOptions,
) {
  const host = std.getOptional(EditorChromeHostIdentifier);
  if (!host || model.store.readonly || !anchor.isConnected) return;
  const command = new EmbedIframeLinkInputBase(
    std,
    model,
    abort,
    inSurface,
    editing,
    options?.telemetrySegment,
  );
  const initialUrl = model.props.url;
  mountInlinePopup(
    std,
    () =>
      anchor.isConnected &&
      model.store.getBlock(model.id)?.model === model &&
      model.props.url === initialUrl
        ? anchor
        : null,
    (controls) =>
      host.renderIframeLinkEditor({
        ...controls,
        editing,
        title: options?.title,
        description: options?.description,
        placeholder: editing ? initialUrl : options?.placeholder,
        showCloseButton: options?.showCloseButton ?? false,
        confirm: (url) => command.confirm(url),
      }),
    abort,
    () => {
      if (std.host.isConnected) std.host.focus();
    },
  );
}
