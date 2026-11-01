import { useState } from "react";
import { createPortal } from "react-dom";
import { useClassSelection } from "./selection";
// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Box,
  Button,
  CanvasOverlayToolbar,
  Group,
  ConfirmModal,
  Select,
  Stack,
  Alert,
  MyoxusText,
  Menu,
  MenuItem,
  Popover,
  PopoverContent,
  Scrollable,
  PopoverTarget,
  ToolbarSurface,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  CLASS_PARENT_ACTIONS,
  CLASS_PARENT_ACTION_LABELS as labels,
  type ClassParentAction,
  type ClassReactHostProps,
  deleteClassSelection,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { ClassForm } from "./class-popover";
import { ClassAddMemberPopover, ClassMemberForm } from "./member-popover";
import { ClassRelationForm } from "./relation-popover";
import { ClassNamespaceForm } from "./namespace-popover";
import { ClassNoteForm } from "./note-popover";
import { ClassCommentsForm, ClassCommentsPopover } from "./comment-popover";
import { ClassAppearanceForm } from "./appearance-popover";
import {
  ClassAccessibilityForm,
  ClassDiagramTitleForm,
} from "./accessibility-popover";
import { useClassDraft } from "./drafts";
import { ClassDataForm } from "./data-popover";
function ClassParentForm({
  props,
  action,
}: {
  props: ClassReactHostProps;
  action: ClassParentAction;
}) {
  const close = () => props.onParentIntent(null);
  switch (action) {
    case "addClass":
      return <ClassForm props={props} onClose={close} />;
    case "connect":
      return <ClassRelationForm props={props} onClose={close} />;
    case "group":
      return <ClassNamespaceForm props={props} group onClose={close} />;
    case "emptyNamespace":
      return <ClassNamespaceForm props={props} onClose={close} />;
    case "addNote":
      return <ClassNoteForm props={props} onClose={close} />;
    case "comments":
      return <ClassCommentsForm props={props} />;
    case "appearance":
      return <ClassAppearanceForm props={props} onClose={close} />;
    case "accessibility":
      return <ClassAccessibilityForm props={props} onClose={close} />;
    case "data":
      return <ClassDataForm props={props} />;
    case "deleteSelection":
      return <ClassSelectionDelete props={props} />;
  }
}
function ClassObjectForm({ props }: { props: ClassReactHostProps }) {
  const selected = props.selected,
    close = () => props.onEditIntent(null);
  if (!selected) return null;
  switch (selected.kind) {
    case "title":
      return <ClassDiagramTitleForm props={props} onClose={close} />;
    case "class":
      return (
        <ClassForm
          props={props}
          node={props.model.nodes.find((n) => n.sourceKey === selected.key)}
          onClose={close}
        />
      );
    case "member": {
      const owner = props.model.nodes.find((n) =>
          n.members.some((member) => member.id === selected.key),
        ),
        member = owner?.members.find((member) => member.id === selected.key);
      return owner && member ? (
        <ClassMemberForm
          props={props}
          classKey={owner.sourceKey}
          member={member}
          onClose={close}
        />
      ) : null;
    }
    case "relation":
      return (
        <ClassRelationForm
          props={props}
          relation={props.model.relations.find(
            (r) => r.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
    case "namespace":
      return (
        <ClassNamespaceForm
          props={props}
          namespace={props.model.namespaces.find(
            (n) => n.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
    case "note":
      return (
        <ClassNoteForm
          props={props}
          note={props.model.notes.find((n) => n.sourceKey === selected.key)}
          onClose={close}
        />
      );
  }
}
function ClassActionPopover({
  props,
  action,
  disabled = false,
}: {
  props: ClassReactHostProps;
  action: ClassParentAction;
  disabled?: boolean;
}) {
  return (
    <Popover
      fitViewport
      trapFocus
      opened={props.parentIntent === action}
      onChange={(opened) => {
        if (!opened) props.onParentIntent(null);
      }}
    >
      <PopoverTarget>
        <Button
          disabled={disabled}
          aria-label={
            action === "group" && !props.groupAllowed
              ? `${labels[action]()}. ${m.classGroupSelection()}`
              : labels[action]()
          }
          onClick={() =>
            props.onParentIntent(props.parentIntent === action ? null : action)
          }
        >
          {labels[action]()}
        </Button>
      </PopoverTarget>
      <PopoverContent>
        <Scrollable.Viewport autosize maxHeight="floating">
          {props.parentIntent === action ? (
            <ClassParentForm
              key={`${action}:${props.selectedKeys.join(",")}`}
              props={props}
              action={action}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
}
export function MermaidClassRuntimeEditor({
  props: inputProps,
}: {
  props: ClassReactHostProps;
}) {
  const props = useClassSelection(inputProps);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const primary = CLASS_PARENT_ACTIONS.filter((a) =>
      ["addClass", "connect", "group", "addNote"].includes(a),
    ),
    more = CLASS_PARENT_ACTIONS.filter((a) => !primary.includes(a));
  const actions = (
    <Group
      aria-label={m.controlsLabel()}
      data-myoxus-ui-role="mermaid-class-actions"
    >
      {!props.readonly
        ? primary.map((action) =>
            action === "group" ? (
              <Tooltip
                key={action}
                content={
                  props.groupAllowed ? m.classGroup() : m.classGroupSelection()
                }
              >
                <span>
                  <ClassActionPopover
                    props={props}
                    action={action}
                    disabled={!props.groupAllowed}
                  />
                </span>
              </Tooltip>
            ) : (
              <ClassActionPopover
                key={action}
                props={props}
                action={action}
                disabled={
                  action === "connect" &&
                  !props.model.nodes.some((n) => n.kind === "class")
                }
              />
            ),
          )
        : null}
      <Menu
        title={m.visualMoreActions()}
        items={
          <>
            {more
              .filter(
                (action) =>
                  action !== "deleteSelection" || props.selectedKeys.length > 0,
              )
              .map((action) => (
                <MenuItem
                  key={action}
                  disabled={
                    props.readonly &&
                    ["emptyNamespace", "deleteSelection"].includes(action)
                  }
                  onSelect={() =>
                    action === "comments"
                      ? setCommentsVisible(!commentsVisible)
                      : props.onParentIntent(action)
                  }
                >
                  {labels[action]()}
                </MenuItem>
              ))}
          </>
        }
      >
        <Button>{m.visualMoreActions()}</Button>
      </Menu>
      {props.parentIntent && more.includes(props.parentIntent) ? (
        <ClassActionPopover props={props} action={props.parentIntent} />
      ) : null}
    </Group>
  );
  const selected = props.selected;
  const selectedControl =
    selected && !props.displayOnly ? (
      <Group>
        <Popover
          fitViewport
          trapFocus
          opened={Boolean(props.intent)}
          onChange={(opened) => {
            if (!opened) props.onEditIntent(null);
          }}
        >
          <PopoverTarget>
            <Button
              onClick={() =>
                props.onEditIntent({
                  kind:
                    selected.kind === "member"
                      ? "detail"
                      : selected.kind === "namespace"
                        ? "subgraph"
                        : selected.kind === "relation"
                          ? "edge"
                          : "node",
                  id: selected.key,
                  ownerId: selected.ownerKey,
                })
              }
            >
              {selected.kind === "title"
                ? m.titlePlaceholder()
                : selected.kind === "member"
                  ? m.classMember()
                  : selected.kind === "namespace"
                    ? m.classNamespace()
                    : selected.kind === "note"
                      ? m.classAddNote()
                      : selected.kind === "relation"
                        ? m.selectedEdgeType()
                        : m.classClassId()}
            </Button>
          </PopoverTarget>
          <PopoverContent>
            <Scrollable.Viewport autosize maxHeight="floating">
              {props.intent ? (
                <ClassObjectForm
                  key={`${selected.kind}:${selected.key}`}
                  props={props}
                />
              ) : null}
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
        {selected.kind === "class" || selected.kind === "member" ? (
          <ClassAddMemberPopover
            props={props}
            classKey={selected.ownerKey ?? selected.key}
          />
        ) : null}
        {selected.kind !== "title" ? (
          <ClassCommentsPopover
            props={props}
            anchor={{
              anchorKind: selected.kind,
              anchorId: selected.key,
              position: "before",
            }}
          />
        ) : null}
      </Group>
    ) : null;
  const markers = commentsVisible
    ? props.commentMarkers.map((marker) => (
        <Box
          key={marker.key}
          data-myoxus-ui-role="mermaid-class-comment-marker"
          pos={props.markersInClientSpace ? "fixed" : "absolute"}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            left: marker.left,
            top: marker.top,
            transform: "translate(-50%, -50%)",
            zIndex: "var(--myoxus-z-index-popover)",
          }}
        >
          <ClassCommentsPopover
            props={props}
            anchor={marker.anchor}
            marker
            count={marker.count}
          />
        </Box>
      ))
    : null;
  if (props.surface === "controls")
    return (
      <Group
        // Portalled drafts remain owned by the native toolbar, not the canvas
        // under their DOM location. Keep selection while confirming a draft.
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
        {props.placementPending ? (
          <MyoxusText role="status">
            {m.visualPlaceShape(m.classAddClass())}
          </MyoxusText>
        ) : null}
        {selectedControl}
        {markers && typeof document !== "undefined"
          ? createPortal(markers, document.body)
          : null}
      </Group>
    );
  const controls =
    selectedControl && props.selectedAnchor ? (
      <Box
        pos="absolute"
        style={{
          left: props.selectedAnchor.left,
          top: props.selectedAnchor.top,
          transform: "translate(-50%, -100%)",
        }}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <CanvasOverlayToolbar>
          <ToolbarSurface placement="inline">{selectedControl}</ToolbarSurface>
        </CanvasOverlayToolbar>
      </Box>
    ) : null;
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
        props.onEditIntent(null);
        props.onParentIntent(null);
        props.resolveReturnFocusTarget()?.focus();
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
      selectionKey={selected ? `${selected.kind}:${selected.key}` : ""}
      selectionControls={
        <>
          {markers}
          {controls}
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

function ClassSelectionDelete({ props }: { props: ClassReactHostProps }) {
  const d = useClassDraft({ notes: "" }, props);
  const impact = deleteClassSelection(
    props.model,
    props.selectedKeys,
    "delete",
  ).impact;
  return (
    <ConfirmModal
      open
      onOpenChange={(open) => {
        if (!open) props.onParentIntent(null);
      }}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      onConfirm={() => {
        const result = d.commit("deleteClassSelection", [
          props.selectedKeys,
          d.value.notes ? (d.value.notes as "keep-free" | "delete") : undefined,
        ]);
        if (!result.diagnostic) {
          props.onParentIntent(null);
          props.onCloseSelection();
        }
      }}
    >
      <Stack>
        {impact.records.map((record) => (
          <MyoxusText key={record.id}>{record.label}</MyoxusText>
        ))}
        {impact.attachedNotes.length ? (
          <Select
            label={m.classNotesStrategy()}
            data={[
              { value: "keep-free", label: m.classKeepNotes() },
              { value: "delete", label: m.classDeleteNotes() },
            ]}
            value={d.value.notes}
            onChange={(value) => d.set("notes", value)}
          />
        ) : null}
        {d.diagnostic ? (
          <Alert color="myoxusError" role="alert">
            {d.diagnostic}
          </Alert>
        ) : null}
      </Stack>
    </ConfirmModal>
  );
}
