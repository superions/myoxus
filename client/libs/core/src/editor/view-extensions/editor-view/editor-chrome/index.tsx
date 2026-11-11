// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorDocumentCard } from "./document-card";
import { EditorAttachmentCard } from "./attachment-card";

import { EditorSelectionToolbar } from "./selection-toolbar";

import type { ReactToLit } from "@myoxus/lit-react";
import { EditorChromeHostExtension } from "@virgultum/editor/shared/services";
import { EditorSlashMenu } from "./slash-menu";
import { EditorZoom } from "./zoom";
import { EditorImageFallback } from "./image-fallback";
import { EditorIframeStatusCard } from "./iframe-status-card";
import { EditorIframeLinkEditor } from "./iframe-link-editor";
import { EditorLinkEditor } from "./link-editor";
import { EditorReferenceEditor } from "./reference-editor";
import { EditorDocumentPicker } from "./document-picker";
import { EditorCodeToolbar } from "./code-toolbar";
import { EditorAttachmentRename } from "./attachment-rename";
import { EditorTableMenu } from "./table-menu";
import { EditorEmbedCardCreate } from "./embed-card-create";
import { EditorEmbedCardEdit } from "./embed-card-edit";
import { EditorEquation } from "./equation-editor";
import { EditorBlockCaption } from "./block-caption";
import { EditorCitationPreview } from "./citation-preview";
import { EditorDocumentOutline, EditorOutlineEntry } from "./document-outline";

/** Reuse the owning React tree so editor chrome inherits its theme and services. */
export function patchEditorChromeHost(reactToLit: ReactToLit) {
  return EditorChromeHostExtension({
    renderImageFallback: (controls) =>
      reactToLit(<EditorImageFallback controls={controls} />, true),
    renderDocumentCard: (controls) =>
      reactToLit(<EditorDocumentCard controls={controls} />, true),
    renderAttachmentCard: (controls) =>
      reactToLit(<EditorAttachmentCard controls={controls} />, true),
    renderDocumentOutline: (controls) =>
      reactToLit(<EditorDocumentOutline controls={controls} />, true),
    renderOutlineEntry: (controls) =>
      reactToLit(<EditorOutlineEntry {...controls} />, true),
    renderCitationPreview: (controls) =>
      reactToLit(<EditorCitationPreview controls={controls} />, true),
    renderBlockCaption: (controls) =>
      reactToLit(<EditorBlockCaption controls={controls} />, true),
    renderEquation: (controls) =>
      reactToLit(<EditorEquation controls={controls} />, true),
    renderEmbedCardEdit: (controls) =>
      reactToLit(<EditorEmbedCardEdit controls={controls} />, true),
    renderEmbedCardCreate: (controls) =>
      reactToLit(<EditorEmbedCardCreate controls={controls} />, true),
    renderTableMenu: (controls) =>
      reactToLit(<EditorTableMenu controls={controls} />, true),
    renderAttachmentRename: (controls) =>
      reactToLit(<EditorAttachmentRename controls={controls} />, true),
    renderCodeToolbar: (controls) =>
      reactToLit(<EditorCodeToolbar controls={controls} />, true),
    renderDocumentPicker: (controls) =>
      reactToLit(<EditorDocumentPicker controls={controls} />, true),
    renderIframeStatusCard: (controls) =>
      reactToLit(<EditorIframeStatusCard controls={controls} />, true),
    renderIframeLinkEditor: (controls) =>
      reactToLit(<EditorIframeLinkEditor controls={controls} />, true),
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
