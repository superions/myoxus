// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import { LinkIcon, PlusIcon, TrashIcon } from "@myoxus/icons";
import {
  Box,
  CanvasOverlayToolbar,
  Group,
  IconButton,
  Menu,
  MenuItem,
  ToolbarSurface,
} from "@myoxus/ui-facade";
import type { MermaidArchitectureEditorReactHostProps } from "@virgultum/block-mermaid";

import {
  MermaidGfxEditorWorkbench,
  MermaidSelectionDeleteAction,
} from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { MermaidArchitectureCommentPopover } from "./comment-popover";
import { MermaidArchitectureDiagramSettings } from "./diagram-settings";
import { useArchitectureLayoutPreview } from "./layout-preview";
import { MermaidArchitectureMoreMenu } from "./more-menu";
import { MermaidArchitectureObjectPopover } from "./object-popover";

export function MermaidArchitectureRuntimeEditor({
  props,
}: {
  readonly props: MermaidArchitectureEditorReactHostProps;
}) {
  const t = useI18n();
  const layoutPreview = useArchitectureLayoutPreview(props);
  const moreActions = t["com.myoxus.editor.mermaid.visual-more-actions"]();
  const diagramComments = props.comments.filter(
    (comment) => comment.anchorKind === "diagram",
  );
  const selectedComments = props.comments.filter(
    (comment) =>
      comment.anchorId === props.selectionCommentAnchor.anchorId &&
      comment.anchorKind === props.selectionCommentAnchor.anchorKind,
  );
  const alignmentSelected = props.selectionKey.startsWith("alignment:");
  const showObjectProperties = !alignmentSelected && !props.displayOnly;
  const showSelectedComments = !props.readonly || selectedComments.length > 0;
  const showSelectionDelete = !props.readonly && !alignmentSelected;
  const showAlignmentDelete =
    !props.readonly && alignmentSelected && props.canDeleteAlignment;
  const showSelectionToolbar =
    showObjectProperties ||
    showSelectedComments ||
    showSelectionDelete ||
    showAlignmentDelete;
  const selectedCommentKey = props.selectionKey
    ? `${props.selectionCommentAnchor.anchorKind}:${props.selectionCommentAnchor.anchorId ?? ""}`
    : "";
  const primaryActions = (
    <Group
      aria-label={props.labels.toolbar}
      data-myoxus-ui-role="mermaid-architecture-toolbar"
      gap="xs"
      justify="flex-start"
      role="group"
      wrap="nowrap"
    >
      {!props.readonly ? (
        <>
          <Menu
            items={
              <>
                <MenuItem onSelect={props.onAddService}>
                  {props.labels.addService}
                </MenuItem>
                <MenuItem onSelect={props.onAddJunction}>
                  {props.labels.addJunction}
                </MenuItem>
                <MenuItem
                  aria-label={
                    props.canAddGroup
                      ? props.labels.addGroup
                      : `${props.labels.addGroup}. ${props.addGroupDisabledReason}`
                  }
                  disabled={!props.canAddGroup}
                  onSelect={props.onAddGroup}
                  title={props.addGroupDisabledReason || undefined}
                >
                  {props.labels.addGroup}
                </MenuItem>
              </>
            }
            title={props.labels.add}
          >
            <IconButton
              aria-label={props.labels.add}
              icon={<PlusIcon />}
              tooltip={props.labels.add}
            />
          </Menu>
          <IconButton
            aria-label={
              props.connecting
                ? `${props.labels.connecting}. ${props.labels.connectingHint}`
                : !props.canConnect
                  ? `${props.labels.connect}. ${props.connectDisabledReason}`
                  : props.labels.connect
            }
            aria-pressed={props.connecting}
            disabled={!props.canConnect && !props.connecting}
            icon={<LinkIcon />}
            onClick={props.onConnect}
            tooltip={
              props.connecting
                ? `${props.labels.connecting}. ${props.labels.connectingHint}`
                : !props.canConnect
                  ? `${props.labels.connect}. ${props.connectDisabledReason}`
                  : props.labels.connect
            }
          />
        </>
      ) : null}
      {!props.readonly || diagramComments.length ? (
        <MermaidArchitectureCommentPopover
          anchor={{ anchorKind: "diagram" }}
          comments={diagramComments}
          marker
          props={props}
        />
      ) : null}
      <MermaidArchitectureMoreMenu
        label={moreActions}
        onLayoutOpen={layoutPreview.open}
        preview={layoutPreview.preview}
        props={props}
      />
      {props.embedded && props.selectionCount > 1 ? (
        <MermaidSelectionDeleteAction
          action={props.selectionAction}
          resolveReturnFocusTarget={props.resolveReturnFocusTarget}
        />
      ) : null}
    </Group>
  );
  const anchoredCommentMarkers = props.commentMarkers
    .filter((marker) => marker.key !== selectedCommentKey)
    .map((marker) => (
      <Box
        data-myoxus-ui-role="mermaid-architecture-comment-marker"
        key={marker.key}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => event.stopPropagation()}
        pos="absolute"
        style={{
          left: marker.left,
          top: marker.top,
          transform: "translate(-50%, -50%)",
          zIndex: "var(--myoxus-z-index-popover)",
        }}
      >
        <MermaidArchitectureCommentPopover
          anchor={marker.anchor}
          comments={marker.comments}
          marker
          props={props}
        />
      </Box>
    ));
  const selectionControls =
    props.selectionAnchor && props.selectionKey ? (
      <>
        {anchoredCommentMarkers}
        {showSelectionToolbar ? (
          <Box
            data-myoxus-ui-role="mermaid-architecture-object-actions"
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            pos="absolute"
            style={{
              left: props.selectionAnchor.left,
              top: props.selectionAnchor.top,
              transform:
                "translate(-50%, calc(-100% - var(--mantine-spacing-xs)))",
              zIndex: "var(--myoxus-z-index-popover)",
            }}
          >
            <CanvasOverlayToolbar>
              <ToolbarSurface compact>
                <Group gap="xs" wrap="nowrap">
                  {showObjectProperties ? (
                    <MermaidArchitectureObjectPopover props={props} />
                  ) : null}
                  {showSelectedComments ? (
                    <MermaidArchitectureCommentPopover
                      anchor={props.selectionCommentAnchor}
                      comments={selectedComments}
                      marker
                      props={props}
                    />
                  ) : null}
                  {showSelectionDelete ? (
                    <MermaidSelectionDeleteAction
                      action={props.selectionAction}
                      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
                    />
                  ) : null}
                  {showAlignmentDelete ? (
                    <IconButton
                      aria-label={props.labels.deleteAlignment}
                      icon={<TrashIcon />}
                      onClick={props.onDeleteAlignment}
                      tooltip={props.labels.deleteAlignment}
                    />
                  ) : null}
                </Group>
              </ToolbarSurface>
            </CanvasOverlayToolbar>
          </Box>
        ) : null}
      </>
    ) : (
      anchoredCommentMarkers
    );
  return (
    <MermaidGfxEditorWorkbench
      isolateEvents={!props.embedded}
      pageViewport={props.embedded ? undefined : props.pageViewport}
      actionTarget={props.displayOnly ? undefined : props.actionTarget}
      context={null}
      contextOpened={false}
      contextTitle={props.labels.properties}
      onCloseContext={props.onCloseSelection}
      embeddedActions={
        props.embedded && props.embeddedEditing && !props.displayOnly ? (
          <MermaidEmbeddedActions
            actions={primaryActions}
            label={props.labels.toolbar}
          />
        ) : null
      }
      onEmbeddedActionsInsetChange={props.onEmbeddedActionsInsetChange}
      onWorkareaResize={props.onWorkareaResize}
      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      selectionKey={props.selectionKey}
      selectionControls={selectionControls}
      toolbar={
        props.embedded ? null : props.displayOnly ? (
          <Group gap="xs" wrap="nowrap">
            {diagramComments.length ? (
              <MermaidArchitectureCommentPopover
                anchor={{ anchorKind: "diagram" }}
                comments={diagramComments}
                marker
                props={props}
              />
            ) : null}
            <MermaidArchitectureDiagramSettings props={props} />
          </Group>
        ) : (
          primaryActions
        )
      }
      workarea={props.workarea}
      workareaFooter={props.workareaFooter}
      workareaLabel={props.labels.toolbar}
      workareaAccessibilityDescription={props.accessibilityDescription}
      workareaAccessibilityTitle={
        props.accessibilityTitle || props.diagramTitle || props.labels.toolbar
      }
    />
  );
}
