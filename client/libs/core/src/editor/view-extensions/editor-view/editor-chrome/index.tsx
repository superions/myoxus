// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026-present Daniel Scharf and Myoxus contributors

import { EditorCodePreview } from "../../code-block-preview/preview";
import { EditorEmbeddedUIRoot } from "../embedded-ui-root";
import { RegisteredTableControl } from "./table-control";
import { EditorDisclosureToggle } from "./disclosure-toggle";
import { EditorIconPickerPopup } from "./icon-picker-popup";
import { EditorCanvasPopover } from "./canvas-popover";
import { EditorSurfaceRefPlaceholder } from "./surface-ref-placeholder";
import { EditorHtmlEmbedCard } from "./html-embed-card";
import { EditorDocumentCard } from "./document-card";
import { RegisteredAttachmentCard } from "./attachment-card";
import { RegisteredBookmarkCard } from "./bookmark-card";
import { EditorGithubCard } from "./github-card";
import { EventReferenceCard } from "./event-card";
import { EditorHtmlFullscreenToolbar } from "./html-fullscreen-toolbar";
import { EditorYoutubeCard } from "./youtube-card";
import { EditorFigmaCard } from "./figma-card";
import { EditorLoomCard } from "./loom-card";

import type { MountReactPortal } from "@myoxus/core/editor/portal";
import {
  EditorAutoComplete,
  EditorAutoConnect,
  EditorNoteSlicer,
} from "./auto-complete";
import { EditorCanvasMenu } from "./canvas-menu";
import { EditorCanvasDock } from "./canvas-toolbar";

import { EditorSelectionToolbar } from "./selection-toolbar";

import type { ReadonlySignal } from "@preact/signals-core";
import { useSyncExternalStore, type ComponentType } from "react";
import {
  EditorChromeHostExtension,
  type EditorOutlineEntryControls,
} from "@virgultum/editor/shared/services";
import { EditorSlashMenu } from "./slash-menu";
import { EditorZoom } from "./zoom";
import { RegisteredImageFallback } from "./image-fallback";
import { RegisteredIframeStatusCard } from "./iframe-status-card";
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
import { EmbedTargetPickerModal } from "../embed-target-picker";
import { EditorEquation } from "./equation-editor";
import { RegisteredBlockCaption } from "./block-caption";
import { EditorCitationPreview } from "./citation-preview";
import { EditorDocumentOutline, EditorOutlineEntry } from "./document-outline";
import {
  EditorFrameNavigator,
  EditorFrameCard,
  EditorFrameTitle,
} from "./frame-navigator";

function RegisteredStateControl<Controls>({
  state,
  View,
}: {
  state: ReadonlySignal<Controls | null>;
  View: ComponentType<{ controls: Controls }>;
}) {
  const controls = useSyncExternalStore(
    (onStoreChange) => state.subscribe(onStoreChange),
    () => state.peek(),
  );
  return controls ? <View controls={controls} /> : null;
}

function RegisteredOutlineEntry({
  controls,
}: {
  controls: EditorOutlineEntryControls;
}) {
  return <EditorOutlineEntry {...controls} />;
}

/** Reuse the owning React tree so editor chrome inherits its theme and services. */
export function patchEditorChromeHost(mountPortal: MountReactPortal) {
  const mountControl =
    <Controls,>(View: ComponentType<{ controls: Controls }>) =>
    (anchor: HTMLElement, controls: Controls) =>
      mountPortal(anchor, <View controls={controls} />);
  const mountStateControl =
    <Controls,>(
      View: ComponentType<{ controls: Controls }>,
      embedded = false,
    ) =>
    (anchor: HTMLElement, state: ReadonlySignal<Controls | null>) =>
      mountPortal(
        anchor,
        embedded ? (
          <EditorEmbeddedUIRoot portalRoot={anchor}>
            <RegisteredStateControl state={state} View={View} />
          </EditorEmbeddedUIRoot>
        ) : (
          <RegisteredStateControl state={state} View={View} />
        ),
      );
  return EditorChromeHostExtension({
    mountTableControl: (anchor, state) =>
      mountPortal(
        anchor,
        <EditorEmbeddedUIRoot portalRoot={anchor}>
          <RegisteredTableControl state={state} />
        </EditorEmbeddedUIRoot>,
      ),
    mountDisclosureControl: mountStateControl(EditorDisclosureToggle, true),
    mountIconPicker: mountControl(EditorIconPickerPopup),
    mountCanvasPopover: mountStateControl(EditorCanvasPopover, true),
    mountSurfaceRefPlaceholder: mountStateControl(
      EditorSurfaceRefPlaceholder,
      true,
    ),
    mountHtmlEmbed: mountStateControl(EditorHtmlEmbedCard, true),
    mountNoteSlicer: mountStateControl(EditorNoteSlicer, true),
    mountAutoConnect: mountStateControl(EditorAutoConnect, true),
    mountAutoComplete: mountStateControl(EditorAutoComplete, true),
    mountCanvasMenu: mountStateControl(EditorCanvasMenu, true),
    mountCanvasDock: (anchor, controls) =>
      mountPortal(anchor, <EditorCanvasDock controls={controls} />),
    mountFrameNavigator: mountStateControl(EditorFrameNavigator),
    mountFrameCard: mountStateControl(EditorFrameCard),
    mountFrameTitle: mountStateControl(EditorFrameTitle),
    mountCodePreview: mountControl(EditorCodePreview),
    mountImageFallback: (anchor, state) =>
      mountPortal(anchor, <RegisteredImageFallback state={state} />),
    mountDocumentCard: mountStateControl(EditorDocumentCard),
    mountAttachmentCard: (anchor, state) =>
      mountPortal(
        anchor,
        <RegisteredAttachmentCard state={state} portalRoot={anchor} />,
      ),
    mountBookmarkCard: (anchor, state) =>
      mountPortal(anchor, <RegisteredBookmarkCard state={state} />),
    mountGithubCard: mountStateControl(EditorGithubCard),
    mountEventReference: mountControl(EventReferenceCard),
    mountHtmlFullscreenToolbar: mountStateControl(
      EditorHtmlFullscreenToolbar,
      true,
    ),
    mountYoutubeCard: mountStateControl(EditorYoutubeCard, true),
    mountFigmaCard: mountStateControl(EditorFigmaCard, true),
    mountLoomCard: mountStateControl(EditorLoomCard, true),
    mountDocumentOutline: mountControl(EditorDocumentOutline),
    mountOutlineEntry: mountStateControl(RegisteredOutlineEntry, true),
    mountCitationPreview: mountControl(EditorCitationPreview),
    mountBlockCaption: (anchor, state) =>
      mountPortal(anchor, <RegisteredBlockCaption state={state} />),
    mountEquation: mountControl(EditorEquation),
    mountEmbedCardEdit: mountControl(EditorEmbedCardEdit),
    mountEmbedTargetPicker: (anchor, controls) =>
      mountPortal(
        anchor,
        <EmbedTargetPickerModal
          pageId={controls.pageId}
          workspaceId={controls.workspaceId}
          params={controls.params}
          apply={controls.apply}
          close={controls.close}
        />,
      ),
    mountEmbedCardCreate: mountControl(EditorEmbedCardCreate),
    mountActionMenu: mountControl(EditorActionMenu),
    mountAttachmentRename: mountControl(EditorAttachmentRename),
    mountCodeToolbar: mountControl(EditorCodeToolbar),
    mountImport: (container, controls) =>
      mountPortal(container, <EditorImportDialog controls={controls} />),
    mountDocumentPicker: mountControl(EditorDocumentPicker),
    mountIframeStatusCard: (anchor, state) =>
      mountPortal(anchor, <RegisteredIframeStatusCard state={state} />),
    mountIframeLinkEditor: mountControl(EditorIframeLinkEditor),
    mountLinkEditor: mountControl(EditorLinkEditor),
    mountReferenceEditor: mountControl(EditorReferenceEditor),
    mountSelection: mountControl(EditorSelectionToolbar),
    mountSlash: mountControl(EditorSlashMenu),
    mountZoom: (anchor, controls) =>
      mountPortal(anchor, <EditorZoom controls={controls} />),
  });
}
