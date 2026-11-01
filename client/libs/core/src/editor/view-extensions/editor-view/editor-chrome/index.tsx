// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorSelectionToolbar } from "./selection-toolbar";

import type { ReactToLit } from "@myoxus/lit-react";
import { EditorChromeHostExtension } from "@virgultum/editor/shared/services";
import { EditorSlashMenu } from "./slash-menu";
import { EditorZoom } from "./zoom";
import { EditorLinkEditor } from "./link-editor";
import { EditorReferenceEditor } from "./reference-editor";

/** Reuse the owning React tree so editor chrome inherits its theme and services. */
export function patchEditorChromeHost(reactToLit: ReactToLit) {
  return EditorChromeHostExtension({
    renderLinkEditor: (controls) =>
      reactToLit(<EditorLinkEditor controls={controls} />, true),
    renderReferenceEditor: (controls) =>
      reactToLit(<EditorReferenceEditor controls={controls} />, true),
    renderSelection: (controls) =>
      reactToLit(<EditorSelectionToolbar controls={controls} />, true),
    renderSlash: (controls) =>
      reactToLit(<EditorSlashMenu controls={controls} />, true),
    renderZoom: (controls) =>
      reactToLit(<EditorZoom controls={controls} />, true),
  });
}
