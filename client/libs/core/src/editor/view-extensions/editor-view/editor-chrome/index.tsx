// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { renderCodePreviewStatus } from "../../code-block-preview/status-view";
import { decorateEditorEmbeddedUI } from "../embedded-ui-root";
import { EditorTableControl } from "./table-control";
import { EditorDocumentCard } from "./document-card";
import { EditorAttachmentCard } from "./attachment-card";
import { EditorBookmarkCard } from "./bookmark-card";
import { EditorGithubCard } from "./github-card";
import { EditorEventCard } from "./event-card";
import { EditorHtmlFullscreenToolbar } from "./html-fullscreen-toolbar";
import { EditorYoutubeCard } from "./youtube-card";
import { EditorFigmaCard } from "./figma-card";
import { EditorLoomCard } from "./loom-card";

import { Group, Box } from "@myoxus/ui-facade";
import { type MountReactPortal, toReactNode } from "@myoxus/lit-react";
import {
  EditorAutoCompleteTrigger,
  EditorAutoCompletePanel,
  EditorAutoConnectLabel,
  EditorAutoConnectNavigator,
} from "./auto-complete";
import { EditorCanvasTemplates } from "./canvas-templates";
import { EditorKeyboardToolbar, EditorKeyboardPanel } from "./keyboard-toolbar";
import { EditorFrameOrder } from "./frame-order";
import { EditorCanvasMenu } from "./canvas-menu";
import { EditorCanvasToolbar, EditorCanvasTool } from "./canvas-toolbar";

import { EditorSelectionToolbar } from "./selection-toolbar";

import type { ReactToLit, LitPortalDecorator } from "@myoxus/lit-react";
import type { ComponentType } from "react";
import { EditorChromeHostExtension } from "@virgultum/editor/shared/services";
import { EditorSlashMenu } from "./slash-menu";
import { EditorZoom } from "./zoom";
import { EditorImageFallback } from "./image-fallback";
import { EditorIframeStatusCard } from "./iframe-status-card";
import { EditorIframeLinkEditor } from "./iframe-link-editor";
import { EditorLinkEditor } from "./link-editor";
import { EditorReferenceEditor } from "./reference-editor";
import { EditorImportDialog } from "./import-dialog";
import { EditorDocumentPicker } from "./document-picker";
import { EditorCodeToolbar } from "./code-toolbar";
import { EditorAttachmentRename } from "./attachment-rename";
import { EditorActionMenu } from "./action-menu";
import { EditorEmbedCardCreate } from "./embed-card-create";
import { EditorEmbedCardEdit } from "./embed-card-edit";
import { EditorEquation } from "./equation-editor";
import { EditorBlockCaption } from "./block-caption";
import { EditorCitationPreview } from "./citation-preview";
import { EditorDocumentOutline, EditorOutlineEntry } from "./document-outline";
import {
  EditorFrameNavigator,
  EditorFrameCard,
  EditorFrameTitle,
} from "./frame-navigator";

/** Reuse the owning React tree so editor chrome inherits its theme and services. */
export function patchEditorChromeHost(
  reactToLit: ReactToLit,
  mountPortal?: MountReactPortal,
) {
  const renderControl =
    <Controls,>(
      View: ComponentType<{ controls: Controls }>,
      decorator?: LitPortalDecorator,
    ) =>
    (controls: Controls) =>
      reactToLit(<View controls={controls} />, true, decorator);
  return EditorChromeHostExtension({
    renderTableControl: renderControl(
      EditorTableControl,
      decorateEditorEmbeddedUI,
    ),
    renderAutoCompleteTrigger: renderControl(
      EditorAutoCompleteTrigger,
      decorateEditorEmbeddedUI,
    ),
    renderAutoCompletePanel: renderControl(
      EditorAutoCompletePanel,
      decorateEditorEmbeddedUI,
    ),
    renderAutoConnectLabel: renderControl(
      EditorAutoConnectLabel,
      decorateEditorEmbeddedUI,
    ),
    renderAutoConnectNavigator: renderControl(
      EditorAutoConnectNavigator,
      decorateEditorEmbeddedUI,
    ),
    renderCanvasTemplates: renderControl(EditorCanvasTemplates),
    renderCanvasToolGroup: (content) =>
      reactToLit(
        <Group wrap="nowrap" gap="xs">
          {content.map((item, index) => (
            <Box key={index}>{toReactNode(item)}</Box>
          ))}
        </Group>,
        true,
      ),
    renderCanvasMenu: (controls) =>
      reactToLit(
        <EditorCanvasMenu controls={controls} />,
        true,
        controls.actions.some(
          (action) =>
            action.id === "frame-panel-label" ||
            action.id === "presentation-dark-background" ||
            action.id === "presentation-hide-toolbar",
        )
          ? decorateEditorEmbeddedUI
          : undefined,
      ),
    renderCanvasToolbar: renderControl(EditorCanvasToolbar),
    renderCanvasTool: (controls) =>
      reactToLit(
        <EditorCanvasTool {...controls} />,
        true,
        [
          "note-slicer-split",
          "presentation-settings",
          "presentation-start",
          "presentation-previous",
          "presentation-next",
          "presentation-fullscreen",
          "presentation-stop",
          "presentation-frame-order",
          "toggle-outline-panel-button",
          "myoxus-bpmn-edgeless-toolbar-button",
        ].includes(controls.action.id)
          ? decorateEditorEmbeddedUI
          : undefined,
      ),
    renderKeyboardToolbar: renderControl(EditorKeyboardToolbar),
    renderKeyboardPanel: renderControl(EditorKeyboardPanel),
    renderFrameOrder: renderControl(EditorFrameOrder, decorateEditorEmbeddedUI),
    renderFrameNavigator: renderControl(EditorFrameNavigator),
    renderFrameCard: renderControl(EditorFrameCard),
    renderFrameTitle: renderControl(EditorFrameTitle),
    renderCodePreviewStatus: (status) =>
      renderCodePreviewStatus(reactToLit, status),
    renderImageFallback: renderControl(EditorImageFallback),
    renderDocumentCard: renderControl(EditorDocumentCard),
    renderAttachmentCard: (controls) =>
      reactToLit(
        <EditorAttachmentCard controls={controls} />,
        true,
        controls.statusPopover ? decorateEditorEmbeddedUI : undefined,
      ),
    renderBookmarkCard: renderControl(EditorBookmarkCard),
    renderGithubCard: renderControl(EditorGithubCard),
    renderEventCard: renderControl(EditorEventCard),
    renderHtmlFullscreenToolbar: renderControl(
      EditorHtmlFullscreenToolbar,
      decorateEditorEmbeddedUI,
    ),
    renderYoutubeCard: renderControl(
      EditorYoutubeCard,
      decorateEditorEmbeddedUI,
    ),
    renderFigmaCard: renderControl(EditorFigmaCard, decorateEditorEmbeddedUI),
    renderLoomCard: renderControl(EditorLoomCard, decorateEditorEmbeddedUI),
    renderDocumentOutline: renderControl(EditorDocumentOutline),
    renderOutlineEntry: (controls) =>
      reactToLit(<EditorOutlineEntry {...controls} />, true),
    renderCitationPreview: renderControl(EditorCitationPreview),
    renderBlockCaption: renderControl(EditorBlockCaption),
    renderEquation: renderControl(EditorEquation),
    renderEmbedCardEdit: renderControl(EditorEmbedCardEdit),
    renderEmbedCardCreate: renderControl(EditorEmbedCardCreate),
    renderActionMenu: renderControl(EditorActionMenu),
    renderAttachmentRename: renderControl(EditorAttachmentRename),
    renderCodeToolbar: renderControl(EditorCodeToolbar),
    renderImport: renderControl(EditorImportDialog),
    renderDocumentPicker: renderControl(EditorDocumentPicker),
    renderIframeStatusCard: renderControl(EditorIframeStatusCard),
    renderIframeLinkEditor: renderControl(EditorIframeLinkEditor),
    renderLinkEditor: renderControl(EditorLinkEditor),
    renderReferenceEditor: renderControl(EditorReferenceEditor),
    renderSelection: renderControl(EditorSelectionToolbar),
    renderSlash: renderControl(EditorSlashMenu),
    mountCanvasTool: mountPortal
      ? (anchor, controls) =>
          mountPortal(anchor, <EditorCanvasTool {...controls} />)
      : undefined,
    mountZoom: mountPortal
      ? (anchor, controls) =>
          mountPortal(anchor, <EditorZoom controls={controls} />)
      : undefined,
  });
}
