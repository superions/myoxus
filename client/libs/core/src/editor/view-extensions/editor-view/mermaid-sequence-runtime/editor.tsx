// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { createPortal } from "react-dom";
import {
  Alert,
  Box,
  Button,
  ConfirmModal,
  Group,
  Menu,
  MenuItem,
  MyoxusText,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Stack,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  SEQUENCE_PARENT_ACTIONS,
  SEQUENCE_PARENT_ACTION_LABELS as labels,
  type SequenceReactHostProps,
  type SequenceParentAction,
  type SequenceCommentAnchor,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { useSequenceSelection } from "./selection";
import { useSequenceDraft } from "./drafts";
import {
  SequenceParticipantForm,
  SequenceParticipantHandle,
} from "./participant-popover";
import { SequenceMessageForm, SequenceTimelineHandle } from "./message-popover";
import { SequenceActivationForm } from "./activation-popover";
import { SequenceFragmentForm, SequenceBranchForm } from "./fragment-popover";
import { SequenceBackgroundForm } from "./background-popover";
import { SequenceNoteForm } from "./note-popover";
import { SequenceCommentsPopover } from "./comment-popover";
import { SequenceAppearanceForm } from "./appearance-popover";
import {
  SequenceAccessibilityForm,
  SequenceDiagramTitleForm,
} from "./accessibility-popover";
import { SequenceDataForm } from "./data-popover";
function SequenceParentForm({
  props,
  action,
}: {
  props: SequenceReactHostProps;
  action: SequenceParentAction;
}) {
  const onClose = () => {
    props.onCancelPreview();
    props.onParentIntent(null);
  };
  switch (action) {
    case "participant":
      return <SequenceParticipantForm props={props} onClose={onClose} />;
    case "message":
      return <SequenceMessageForm props={props} onClose={onClose} />;
    case "activation":
      return <SequenceActivationForm props={props} onClose={onClose} />;
    case "fragment":
      return <SequenceFragmentForm props={props} onClose={onClose} />;
    case "box":
    case "rect":
      return (
        <SequenceBackgroundForm props={props} kind={action} onClose={onClose} />
      );
    case "note":
      return <SequenceNoteForm props={props} onClose={onClose} />;
    case "comments":
      return null;
    case "appearance":
      return <SequenceAppearanceForm props={props} onClose={onClose} />;
    case "accessibility":
      return <SequenceAccessibilityForm props={props} onClose={onClose} />;
    case "data":
      return <SequenceDataForm props={props} />;
    case "deleteSelection":
      return <SequenceSelectionDelete props={props} />;
  }
}
function SequenceObjectForm({ props }: { props: SequenceReactHostProps }) {
  const selected = props.selected,
    onClose = () => {
      props.onCancelPreview();
      props.onEditIntent(null);
    };
  if (!selected) return null;
  switch (selected.kind) {
    case "participant":
      return (
        <SequenceParticipantForm
          props={props}
          participant={props.model.participants.find(
            (p) => p.sourceKey === selected.key,
          )}
          onClose={onClose}
        />
      );
    case "message":
      return (
        <SequenceMessageForm
          props={props}
          message={props.model.messages.find((msg) => msg.id === selected.key)}
          onClose={onClose}
        />
      );
    case "activation":
      return (
        <SequenceActivationForm
          props={props}
          activation={props.model.activationIntervals.find(
            (a) => a.id === selected.key,
          )}
          onClose={onClose}
        />
      );
    case "fragment":
      return (
        <SequenceFragmentForm
          props={props}
          fragment={props.model.controls.find(
            (c) =>
              c.id === selected.key ||
              c.branches.some((b) => b.id === selected.key),
          )}
          onClose={onClose}
        />
      );
    case "branch": {
      const fragment = props.model.controls.find((item) =>
        item.branches.some((branch) => branch.id === selected.key),
      );
      const branch = fragment?.branches.find(
        (item) => item.id === selected.key,
      );
      if (!fragment || !branch) return null;
      return branch.kind === "primary" ? (
        <SequenceFragmentForm
          props={props}
          fragment={fragment}
          onClose={onClose}
        />
      ) : (
        <Stack>
          <SequenceBranchForm
            props={props}
            fragment={fragment}
            branch={branch}
          />
          <Button onClick={onClose}>{m.cancel()}</Button>
        </Stack>
      );
    }
    case "box":
    case "rect":
      return (
        <SequenceBackgroundForm
          props={props}
          background={props.model.backgrounds.find(
            (b) => b.id === selected.key,
          )}
          kind={selected.kind}
          onClose={onClose}
        />
      );
    case "note":
      return (
        <SequenceNoteForm
          props={props}
          note={props.model.notes.find((note) => note.id === selected.key)}
          onClose={onClose}
        />
      );
    case "title":
      return <SequenceDiagramTitleForm props={props} onClose={onClose} />;
  }
}
function SequenceActionPopover({
  props,
  action,
  reason,
}: {
  props: SequenceReactHostProps;
  action: SequenceParentAction;
  reason?: string;
}) {
  return (
    <Popover
      fitViewport
      trapFocus
      opened={props.parentIntent === action}
      onChange={(opened) => {
        if (!opened) {
          props.onCancelPreview();
          props.onParentIntent(null);
        }
      }}
    >
      <PopoverTarget>
        <Tooltip content={reason || labels[action]()}>
          <span>
            <Button
              disabled={Boolean(reason)}
              aria-label={
                reason ? `${labels[action]()}. ${reason}` : labels[action]()
              }
              onClick={() =>
                props.onParentIntent(
                  props.parentIntent === action ? null : action,
                )
              }
            >
              {labels[action]()}
            </Button>
          </span>
        </Tooltip>
      </PopoverTarget>
      <PopoverContent
        aria-label={labels[action]()}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <Scrollable.Viewport autosize maxHeight="floating" scrollbars="y">
          {props.parentIntent === action ? (
            <SequenceParentForm
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
export function MermaidSequenceRuntimeEditor({
  props: input,
}: {
  props: SequenceReactHostProps;
}) {
  const props = useSequenceSelection(input),
    [commentsVisible, setCommentsVisible] = useState(false),
    selected = props.selected,
    primaryFragment =
      selected?.kind === "branch"
        ? props.model.controls.find((item) =>
            item.branches.some(
              (branch) =>
                branch.id === selected.key && branch.kind === "primary",
            ),
          )
        : undefined,
    primary = SEQUENCE_PARENT_ACTIONS.filter((action) =>
      ["participant", "message", "activation", "fragment"].includes(action),
    ),
    more = SEQUENCE_PARENT_ACTIONS.filter(
      (action) => !primary.includes(action),
    );
  const reason = (action: SequenceParentAction) =>
    props.readonly &&
    !["comments", "appearance", "accessibility", "data"].includes(action)
      ? m.ganttReadOnly()
      : ["message", "activation", "note"].includes(action) &&
          !props.model.participants.length
        ? m.sequenceParticipantRequired()
        : undefined;
  const actions = (
    <Group
      aria-label={m.controlsLabel()}
      data-myoxus-ui-role="mermaid-sequence-actions"
    >
      {primary.map((action) => (
        <SequenceActionPopover
          key={action}
          props={props}
          action={action}
          reason={reason(action)}
        />
      ))}
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
                  disabled={Boolean(reason(action))}
                  onSelect={() => {
                    if (action === "comments") {
                      setCommentsVisible((visible) => !visible);
                      return;
                    }
                    props.onParentIntent(action);
                  }}
                >
                  {labels[action]()}
                </MenuItem>
              ))}
          </>
        }
      >
        <Button>{m.visualMoreActions()}</Button>
      </Menu>
      {props.parentIntent &&
      more.includes(props.parentIntent) &&
      props.parentIntent !== "deleteSelection" ? (
        <SequenceActionPopover
          props={props}
          action={props.parentIntent}
          reason={reason(props.parentIntent)}
        />
      ) : null}
      {props.parentIntent === "deleteSelection" ? (
        <SequenceSelectionDelete props={props} />
      ) : null}
    </Group>
  );
  const selectedLabel = selected
      ? selected.kind === "title"
        ? m.titlePlaceholder()
        : selected.kind === "participant"
          ? m.sequenceParticipant()
          : selected.kind === "message"
            ? m.sequenceMessage()
            : selected.kind === "activation"
              ? m.sequenceActivation()
              : selected.kind === "note"
                ? m.sequenceNote()
                : selected.kind === "box"
                  ? m.sequenceBox()
                  : selected.kind === "rect"
                    ? m.sequenceRect()
                    : selected.kind === "branch" && !primaryFragment
                      ? m.sequenceBranch()
                      : m.sequenceFragment()
      : undefined,
    edit = () =>
      selected &&
      props.onEditIntent({
        kind:
          selected.kind === "message"
            ? "edge"
            : ["fragment", "box", "rect"].includes(selected.kind)
              ? "subgraph"
              : "node",
        id: selected.visualKey ?? selected.key,
      }),
    form =
      selected && props.intent ? (
        <SequenceObjectForm
          key={`${selected.kind}:${selected.key}`}
          props={props}
        />
      ) : null,
    commentAnchor: SequenceCommentAnchor | undefined =
      selected && selected.kind !== "title"
        ? {
            anchorKind: (["box", "rect"].includes(selected.kind)
              ? "record"
              : selected.kind) as SequenceCommentAnchor["anchorKind"],
            anchorId: selected.key,
            position: selected.kind === "participant" ? "after" : "before",
          }
        : undefined,
    reorder = primaryFragment ? (
      <SequenceTimelineHandle
        props={props}
        id={primaryFragment.id}
        command="reorderSequenceFragment"
      />
    ) : selected?.kind === "message" ||
      selected?.kind === "note" ||
      selected?.kind === "fragment" ? (
      <SequenceTimelineHandle
        props={props}
        id={selected.key}
        command={
          selected.kind === "message"
            ? "reorderSequenceMessage"
            : selected.kind === "note"
              ? "reorderSequenceNote"
              : "reorderSequenceFragment"
        }
      />
    ) : selected?.kind === "participant" ? (
      <SequenceParticipantHandle props={props} id={selected.key} />
    ) : null,
    selectedActions =
      selected && !props.displayOnly ? (
        <Group wrap="nowrap">
          {props.surface === "controls" ? (
            <Popover
              fitViewport
              trapFocus
              opened={Boolean(props.intent)}
              onChange={(opened) => {
                if (!opened) props.onEditIntent(null);
              }}
            >
              <PopoverTarget>
                <Button onClick={edit}>{selectedLabel}</Button>
              </PopoverTarget>
              <PopoverContent aria-label={selectedLabel}>
                <Scrollable.Viewport
                  autosize
                  maxHeight="floating"
                  scrollbars="y"
                >
                  {form}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
          ) : (
            <Button onClick={edit}>{selectedLabel}</Button>
          )}
          {reorder}
          {commentAnchor ? (
            <SequenceCommentsPopover props={props} anchor={commentAnchor} />
          ) : null}
          {selected.kind === "participant" ? (
            <Button
              disabled={props.readonly}
              onClick={() => props.onParentIntent("message")}
            >
              {m.sequenceMessage()}
            </Button>
          ) : null}
        </Group>
      ) : null,
    markers = commentsVisible
      ? props.commentMarkers.map((marker) => (
          <Box
            key={marker.key}
            pos={props.markersInClientSpace ? "fixed" : "absolute"}
            data-myoxus-ui-role="mermaid-sequence-comment-marker"
            onPointerDown={(event) => event.stopPropagation()}
            style={{
              left: marker.left,
              top: marker.top,
              transform: "translate(-50%, -50%)",
              zIndex: "var(--myoxus-z-index-popover)",
            }}
          >
            <SequenceCommentsPopover
              props={props}
              anchor={marker.anchor}
              marker
              count={marker.count}
            />
          </Box>
        ))
      : null;
  const intervalHandles =
    selected?.kind === "activation" &&
    props.selectedBounds &&
    !props.displayOnly
      ? (["start", "end"] as const).map((boundary) => (
          <Box
            key={boundary}
            pos={props.surface === "controls" ? "fixed" : "absolute"}
            style={{
              left:
                props.selectedBounds!.left + props.selectedBounds!.width / 2,
              top:
                props.selectedBounds!.top +
                (boundary === "end" ? props.selectedBounds!.height : 0),
              transform: "translate(-50%, -50%)",
              zIndex: "var(--myoxus-z-index-popover)",
            }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <SequenceTimelineHandle
              props={props}
              id={selected.key}
              command="editSequenceActivation"
              boundary={boundary}
            />
          </Box>
        ))
      : null;
  if (props.surface === "controls")
    return (
      <Group
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
        {selectedActions}
        {markers || intervalHandles
          ? createPortal(
              <>
                {markers}
                {intervalHandles}
              </>,
              document.body,
            )
          : null}
      </Group>
    );
  const selectedControls =
    selectedActions && props.selectedAnchor ? (
      <Popover
        key={`${selected?.kind}:${selected?.key}`}
        opened
        fitViewport
        trapFocus={Boolean(props.intent)}
        position={props.intent ? "bottom" : "top"}
        closeOnEscape={Boolean(props.intent)}
        returnFocus={false}
        onChange={(opened) => {
          if (!opened && props.intent) props.onEditIntent(null);
        }}
      >
        <PopoverTarget>
          <Box
            pos="absolute"
            style={{
              left: props.selectedAnchor.left,
              top: props.selectedAnchor.top,
            }}
          />
        </PopoverTarget>
        <PopoverContent
          aria-label={selectedLabel}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Scrollable.Viewport autosize maxHeight="floating" scrollbars="y">
            <Stack>
              {selectedActions}
              {form}
            </Stack>
          </Scrollable.Viewport>
        </PopoverContent>
      </Popover>
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
        props.onCancelPreview();
        props.onEditIntent(null);
        props.onParentIntent(null);
        props.resolveReturnFocusTarget()?.focus({ preventScroll: true });
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
          {selectedControls}
          {intervalHandles}
        </>
      }
      toolbar={
        props.embedded ? null : props.displayOnly ? (
          <Button onClick={() => setCommentsVisible(!commentsVisible)}>
            {m.visualComments()}
          </Button>
        ) : (
          actions
        )
      }
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
function SequenceSelectionDelete({ props }: { props: SequenceReactHostProps }) {
  const d = useSequenceDraft({}, props),
    impact = props.getDeleteImpact(props.selectedKeys);
  return (
    <ConfirmModal
      open
      onOpenChange={(open) => {
        if (!open) props.onParentIntent(null);
      }}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      onConfirm={() => {
        if (
          !d.commit("deleteSequenceSelection", [props.selectedKeys]).diagnostic
        ) {
          props.onParentIntent(null);
          props.onCloseSelection();
        }
      }}
    >
      <Stack>
        {impact.records.map((record) => (
          <MyoxusText key={record.id}>{record.label}</MyoxusText>
        ))}
        {d.diagnostic ? (
          <Alert color="myoxusError">{d.diagnostic}</Alert>
        ) : null}
      </Stack>
    </ConfirmModal>
  );
}
