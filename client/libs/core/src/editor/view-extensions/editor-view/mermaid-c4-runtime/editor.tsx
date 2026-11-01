// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Button,
  CanvasOverlayToolbar,
  Group,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  Stack,
  Switch,
  ToolbarSurface,
  VisuallyHidden,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  c4ActionCatalog,
  c4PageSelectionTools,
  type C4EditorReactHostProps,
  type C4Selection,
  type C4ParentIntent,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { useC4Selection } from "./selection";
import { isolateC4PortalledMouseDown, handleC4PopoverKeyDown } from "./drafts";
import { C4ElementForm } from "./element-popover";
import { C4BoundaryForm } from "./boundary-popover";
import { C4RelationshipRecordForm } from "./relationship-record-popover";
import { C4BoundaryRecordForm } from "./boundary-record-popover";
import { C4RelationshipForm } from "./relationship-popover";
import { C4CommentForm, C4CommentPopover } from "./comment-popover";
import { C4DeleteForm } from "./delete-controls";
import { C4GroupForm } from "./group-controls";
import { C4SelectionDeleteForm } from "./selection-delete-controls";
import { C4HeaderForm } from "./header-controls";
import { C4ConnectForm } from "./connect-popover";
import { C4DiagramSettings } from "./diagram-settings";

function C4ObjectForm({
  props,
  selected,
}: {
  props: C4EditorReactHostProps;
  selected: C4Selection;
}) {
  const close = props.onCloseSelection;
  if (selected.kind === "element") {
    const element = props.model.elements.find(
      (e) => e.resolution!.selectionId === selected.key,
    );
    return element ? (
      <C4ElementForm
        props={props}
        element={element}
        recordKey={selected.recordKey}
        onClose={close}
      />
    ) : null;
  }
  if (selected.kind === "boundary") {
    const boundary = props.model.boundaries.find(
      (b) => b.resolution!.selectionId === selected.key,
    );
    if (boundary && selected.recordKey)
      return (
        <C4BoundaryRecordForm
          props={props}
          boundary={boundary}
          recordKey={selected.recordKey}
          onClose={close}
        />
      );
    return boundary ? (
      <C4BoundaryForm props={props} boundary={boundary} onClose={close} />
    ) : null;
  }
  const relationship = props.model.relationships.find(
    (r) => r.resolution!.selectionId === selected.key,
  );
  if (relationship && selected.recordKey)
    return (
      <C4RelationshipRecordForm
        props={props}
        recordKey={selected.recordKey}
        onClose={close}
      />
    );
  return relationship ? (
    <C4RelationshipForm
      props={props}
      relationship={relationship}
      onClose={close}
    />
  ) : null;
}

function C4ParentForm({
  props,
  action,
  commentsVisible,
  onCommentsVisible,
}: {
  props: C4EditorReactHostProps;
  action: C4ParentIntent;
  commentsVisible: boolean;
  onCommentsVisible: (value: boolean) => void;
}) {
  const close = props.onCloseSelection;
  switch (action) {
    case "group":
      return <C4GroupForm props={props} onClose={close} />;
    case "header":
      return <C4HeaderForm props={props} onClose={close} />;
    case "relation":
      return <C4ConnectForm props={props} onClose={close} />;
    case "more":
      return <C4DiagramSettings props={props} onClose={close} />;
    case "addElement":
      return <C4ElementForm props={props} onClose={close} />;
    case "emptyBoundary":
      return <C4BoundaryForm props={props} onClose={close} />;
    case "comments":
      return (
        <Stack>
          <Switch checked={commentsVisible} onChange={onCommentsVisible}>
            {m.visualComments()}
          </Switch>
          <C4CommentForm props={props} onClose={close} />
        </Stack>
      );
    case "deleteSelection": {
      const key =
        props.selectedKeys.length === 1 ? props.selectedKeys[0] : null;
      return key ? (
        <C4DeleteForm
          props={props}
          target={{ selectionId: key }}
          onClose={close}
          onDeleted={close}
        />
      ) : props.selectedKeys.length > 1 ? (
        <C4SelectionDeleteForm props={props} onClose={close} />
      ) : null;
    }
  }
}

/** React owns local forms and intent; all Source and presentation writes use family ports. */
export function MermaidC4RuntimeEditor({
  props: input,
}: {
  props: C4EditorReactHostProps;
}) {
  const { props, selected, anchor } = useC4Selection(input);
  const [commentsVisible, setCommentsVisible] = useState(true);
  const actions =
    !props.displayOnly && !props.readonly ? (
      <Group>
        {c4ActionCatalog(props).map(({ intent: action, label, disabled }) => (
          <Popover
            closeOnEscape={false}
            key={action}
            fitViewport
            trapFocus
            opened={
              props.parentIntent === action ||
              (action === "emptyBoundary" && props.parentIntent === "group")
            }
            onChange={(opened) => {
              if (!opened) props.onParentIntent(null);
            }}
          >
            <PopoverTarget>
              <Button
                disabled={disabled}
                onClick={() =>
                  props.onParentIntent(
                    props.parentIntent === action ||
                      (action === "emptyBoundary" &&
                        props.parentIntent === "group")
                      ? null
                      : action,
                  )
                }
              >
                {label}
              </Button>
            </PopoverTarget>
            <PopoverContent
              data-myoxus-editor-keyboard-owner="c4"
              onMouseDown={isolateC4PortalledMouseDown}
              onKeyDown={(event) =>
                handleC4PopoverKeyDown(event, () => props.onParentIntent(null))
              }
            >
              <Scrollable.Viewport autosize maxHeight="floating">
                {props.parentIntent === action ||
                (action === "emptyBoundary" &&
                  props.parentIntent === "group") ? (
                  <C4ParentForm
                    props={props}
                    action={
                      action === "emptyBoundary" &&
                      props.parentIntent === "group"
                        ? "group"
                        : action
                    }
                    commentsVisible={commentsVisible}
                    onCommentsVisible={setCommentsVisible}
                  />
                ) : null}
              </Scrollable.Viewport>
            </PopoverContent>
          </Popover>
        ))}
      </Group>
    ) : null;
  const selectionLabel = selected
    ? selected.kind === "element"
      ? props.model.elements.find(
          (e) => e.resolution!.selectionId === selected.key,
        )?.label || m.selectedNodeLabel()
      : selected.kind === "boundary"
        ? props.model.boundaries.find(
            (b) => b.resolution!.selectionId === selected.key,
          )?.label || m.selectedSubgraphTitle()
        : props.model.relationships.find(
            (r) => r.resolution!.selectionId === selected.key,
          )?.label || m.selectedEdgeType()
    : "";
  const selectionBounds = selected
    ? props.resolveVisualBounds?.(
        selected.kind === "element"
          ? "node"
          : selected.kind === "boundary"
            ? "subgraph"
            : "edge",
        selected.key,
        true,
      )
    : null;
  const selectionButton = selected ? (
    <Button
      aria-haspopup="dialog"
      aria-expanded={!!props.intent}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() =>
        props.onEditIntent({
          kind:
            selected.kind === "element"
              ? "node"
              : selected.kind === "boundary"
                ? "subgraph"
                : "edge",
          id: selected.key,
        })
      }
    >
      {selectionLabel}
    </Button>
  ) : null;
  const selectionControl =
    selected && !props.displayOnly && !props.readonly ? (
      <Popover
        closeOnEscape={false}
        contentMeasure="reading"
        fitViewport
        floatingStrategy={selectionBounds ? "fixed" : undefined}
        trapFocus
        position="right"
        opened={!!props.intent}
        onChange={(opened) => {
          if (!opened) props.onEditIntent(null);
        }}
      >
        {selectionBounds ? (
          <>
            {createPortal(
              <PopoverTarget>
                {/* Only the reference uses renderer geometry. Native flip/shift
                    keeps the form beside the body while its trigger stays in its slot. */}
                <Box
                  pos="fixed"
                  style={{ ...selectionBounds, pointerEvents: "none" }}
                >
                  <VisuallyHidden>{selectionLabel}</VisuallyHidden>
                </Box>
              </PopoverTarget>,
              document.body,
            )}
            {selectionButton}
          </>
        ) : (
          <PopoverTarget>{selectionButton}</PopoverTarget>
        )}
        <PopoverContent
          data-myoxus-editor-keyboard-owner="c4"
          onMouseDown={isolateC4PortalledMouseDown}
          onKeyDown={(event) =>
            handleC4PopoverKeyDown(event, () => props.onEditIntent(null))
          }
        >
          <Scrollable.Viewport autosize maxHeight="floating">
            {props.intent ? (
              <C4ObjectForm
                key={props.draftIdentity}
                props={props}
                selected={selected}
              />
            ) : null}
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
    ) : null;
  // Only these anchors use renderer geometry. Popover chrome stays with the Facade.
  const markers =
    !props.displayOnly && commentsVisible
      ? props.commentMarkers.map((marker) => (
          <Box
            key={marker.key}
            pos={props.markersInClientSpace ? "fixed" : "absolute"}
            style={{
              left: marker.left,
              top: marker.top,
              transform: "translate(-50%, -50%)",
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <C4CommentPopover props={props} marker={marker} />
          </Box>
        ))
      : null;
  const deleteForm =
    props.parentIntent === "deleteSelection" ? (
      <C4ParentForm
        props={props}
        action="deleteSelection"
        commentsVisible={commentsVisible}
        onCommentsVisible={setCommentsVisible}
      />
    ) : null;
  const groupingAllowed =
    !!props.visualModel &&
    (c4PageSelectionTools.containerAction?.validate({
      items: props.selectedKeys.map((editKey) => ({
        editKey,
        kind: props.model.elements.some(
          (e) => e.resolution!.selectionId === editKey,
        )
          ? "node"
          : props.model.boundaries.some(
                (b) => b.resolution!.selectionId === editKey,
              )
            ? "subgraph"
            : "edge",
      })),
      visualModel: props.visualModel,
    }).valid ??
      false);
  const groupingControl =
    groupingAllowed && !props.readonly && !props.displayOnly ? (
      <Button
        aria-haspopup="dialog"
        aria-expanded={props.parentIntent === "group"}
        onClick={() => props.onParentIntent("group")}
      >
        {m.c4Group()}
      </Button>
    ) : null;
  const selectedAnchors = groupingControl
    ? props.selectedKeys.map((key) =>
        props.resolveVisualAnchor("node", key, true),
      )
    : [];
  // Reuse the object-selection slot and its constrained viewport anchors.
  const selectionAnchor =
    anchor ??
    (selectedAnchors.length && selectedAnchors.every((point) => point !== null)
      ? {
          left:
            selectedAnchors.reduce((sum, point) => sum + point!.left, 0) /
            selectedAnchors.length,
          top: Math.min(...selectedAnchors.map((point) => point!.top)),
        }
      : null);
  if (props.surface === "controls") {
    const sourceSelection =
      props.selectedKeys.length > 0 &&
      props.selectedKeys.every((key) =>
        [
          ...props.model.elements,
          ...props.model.boundaries,
          ...props.model.relationships,
        ].some((owner) => owner.resolution!.selectionId === key),
      );
    return (
      <Group
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
        {selectionControl}
        {groupingControl}
        {sourceSelection && !props.readonly ? (
          <Popover
            closeOnEscape={false}
            fitViewport
            trapFocus
            opened={props.parentIntent === "deleteSelection"}
            onChange={(opened) => {
              if (!opened) props.onCloseSelection();
            }}
          >
            <PopoverTarget>
              <Button
                onClick={() =>
                  props.onParentIntent(
                    props.parentIntent === "deleteSelection"
                      ? null
                      : "deleteSelection",
                  )
                }
              >
                {m.visualDelete()}
              </Button>
            </PopoverTarget>
            <PopoverContent
              data-myoxus-editor-keyboard-owner="c4"
              onMouseDown={isolateC4PortalledMouseDown}
              onKeyDown={(event) =>
                handleC4PopoverKeyDown(event, () => props.onCloseSelection())
              }
            >
              <Scrollable.Viewport autosize maxHeight="floating">
                {deleteForm}
              </Scrollable.Viewport>
            </PopoverContent>
          </Popover>
        ) : null}
        {markers ? createPortal(markers, document.body) : null}
      </Group>
    );
  }
  const selectionControls =
    (selectionControl || groupingControl) && selectionAnchor ? (
      <Box
        pos="absolute"
        style={{
          left: selectionAnchor.left,
          top: selectionAnchor.top,
          transform: "translate(-50%, -100%)",
        }}
        data-myoxus-editor-keyboard-owner="c4"
        onPointerDown={(event) => event.stopPropagation()}
      >
        <CanvasOverlayToolbar>
          <ToolbarSurface placement="inline">
            {selectionControl}
            {groupingControl}
            {deleteForm}
          </ToolbarSurface>
        </CanvasOverlayToolbar>
      </Box>
    ) : (
      deleteForm
    );
  return (
    <MermaidGfxEditorWorkbench
      isolateEvents={!props.embedded}
      pageViewport={props.embedded ? undefined : props.pageViewport}
      actionTarget={props.displayOnly ? undefined : props.actionTarget}
      context={null}
      contextOpened={false}
      onCloseContext={props.onCloseSelection}
      onEscape={() => {
        if (!props.intent && !props.parentIntent) return false;
        props.onCloseSelection();
        return true;
      }}
      onEmbeddedActionsInsetChange={props.onEmbeddedActionsInsetChange}
      embeddedActions={
        props.embedded && props.embeddedEditing && !props.displayOnly ? (
          <MermaidEmbeddedActions actions={actions} label={m.controlsLabel()} />
        ) : null
      }
      onWorkareaResize={props.onWorkareaResize}
      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      selectionKey={props.draftIdentity ?? ""}
      selectionControls={
        <>
          {markers}
          {selectionControls}
        </>
      }
      toolbar={props.embedded || props.displayOnly ? null : actions}
      workarea={props.workarea}
      workareaFooter={props.workareaFooter}
      workareaLabel={m.controlsLabel()}
      workareaAccessibilityTitle={
        props.model.accessibilityTitle || m.controlsLabel()
      }
      workareaAccessibilityDescription={props.model.accessibilityDescription}
    />
  );
}
