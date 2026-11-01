// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { createPortal } from "react-dom";
import { useStateSelection } from "./selection";
import {
  Box,
  Button,
  Group,
  ConfirmModal,
  Stack,
  Alert,
  MyoxusText,
  Menu,
  MenuItem,
  Popover,
  PopoverContent,
  Scrollable,
  PopoverTarget,
  Tooltip,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  STATE_PARENT_ACTIONS,
  STATE_PARENT_ACTION_LABELS as labels,
  type StateParentAction,
  type StateReactHostProps,
  deleteStateSelection,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { StateForm, StateDescriptionForm } from "./state-popover";
import { StateTransitionForm } from "./transition-popover";
import { StatePseudostateForm } from "./pseudostate-popover";
import { StateCompositeForm } from "./composite-popover";
import { StateRegionForm } from "./region-popover";
import { StateNoteForm } from "./note-popover";
import { StateCommentsForm, StateCommentsPopover } from "./comment-popover";
import { StateAppearanceForm } from "./appearance-popover";
import {
  StateAccessibilityForm,
  StateDiagramTitleForm,
} from "./accessibility-popover";
import { useStateDraft } from "./drafts";
import { StateDataForm } from "./data-popover";
function StateParentForm({
  props,
  action,
}: {
  props: StateReactHostProps;
  action: StateParentAction;
}) {
  const close = () => props.onParentIntent(null);
  switch (action) {
    case "addState":
      return <StateForm props={props} onClose={close} />;
    case "transition":
      return <StateTransitionForm props={props} onClose={close} />;
    case "pseudostate":
      return <StatePseudostateForm props={props} onClose={close} />;
    case "group":
      return <StateCompositeForm props={props} group onClose={close} />;
    case "emptyComposite":
      return <StateCompositeForm props={props} onClose={close} />;
    case "region":
      return <StateRegionForm props={props} />;
    case "note":
      return <StateNoteForm props={props} onClose={close} />;
    case "comments":
      return <StateCommentsForm props={props} />;
    case "appearance":
      return <StateAppearanceForm props={props} onClose={close} />;
    case "accessibility":
      return <StateAccessibilityForm props={props} onClose={close} />;
    case "data":
      return <StateDataForm props={props} />;
    case "deleteSelection":
      return <StateSelectionDelete props={props} />;
  }
}
function StateObjectForm({
  props,
  initialDelete = false,
}: {
  props: StateReactHostProps;
  initialDelete?: boolean;
}) {
  const selected = props.selected,
    close = () => props.onEditIntent(null);
  if (!selected) return null;
  switch (selected.kind) {
    case "title":
      return (
        <StateDiagramTitleForm
          props={props}
          onClose={close}
          initialDelete={initialDelete}
        />
      );
    case "state": {
      const node = props.model.states.find((n) => n.sourceKey === selected.key);
      return node?.kind === "state" ? (
        <StateForm
          props={props}
          node={node}
          onClose={close}
          initialDelete={initialDelete}
        />
      ) : node ? (
        <StatePseudostateForm
          props={props}
          node={node}
          onClose={close}
          initialDelete={initialDelete}
        />
      ) : null;
    }
    case "description": {
      const owner = props.model.states.find((n) =>
          n.descriptions?.some((d) => d.id === selected.key),
        ),
        description = owner?.descriptions?.find((d) => d.id === selected.key);
      return owner && description ? (
        <StateDescriptionForm
          props={props}
          owner={owner}
          description={description}
          initialDelete={initialDelete}
          onClose={close}
        />
      ) : null;
    }
    case "transition":
      return (
        <StateTransitionForm
          initialDelete={initialDelete}
          props={props}
          transition={props.model.transitions.find(
            (r) => r.id === selected.key,
          )}
          onClose={close}
        />
      );
    case "composite":
      return (
        <StateCompositeForm
          initialDelete={initialDelete}
          props={props}
          composite={props.model.composites.find(
            (c) => c.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
    case "region":
      return (
        <StateRegionForm
          initialDelete={initialDelete}
          props={props}
          composite={props.model.composites.find(
            (c) => c.sourceKey === selected.ownerKey,
          )}
          regionKey={selected.key}
        />
      );
    case "note":
      return (
        <StateNoteForm
          initialDelete={initialDelete}
          props={props}
          note={props.model.notes.find((n) => n.id === selected.key)}
          onClose={close}
        />
      );
    case "comment":
      return <StateCommentsForm props={props} />;
  }
}
function StateActionPopover({
  props,
  action,
  disabled = false,
}: {
  props: StateReactHostProps;
  action: StateParentAction;
  disabled?: boolean;
}) {
  return (
    <Popover
      fitViewport
      trapFocus
      contentMeasure="reading"
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
              ? `${labels[action]()}. ${m.stateGroupHelp()}`
              : labels[action]()
          }
          onClick={() =>
            props.onParentIntent(props.parentIntent === action ? null : action)
          }
        >
          {labels[action]()}
        </Button>
      </PopoverTarget>
      <PopoverContent aria-labelledby={undefined} aria-label={labels[action]()}>
        <Scrollable.Viewport autosize maxHeight="floating">
          {props.parentIntent === action ? (
            <StateParentForm
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
export function MermaidStateRuntimeEditor({
  props: inputProps,
}: {
  props: StateReactHostProps;
}) {
  const props = useStateSelection(inputProps);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const primary = STATE_PARENT_ACTIONS.filter((a) =>
      ["addState", "transition", "group"].includes(a),
    ),
    more = STATE_PARENT_ACTIONS.filter((a) => !primary.includes(a));
  const actions = (
    <Group
      aria-label={m.controlsLabel()}
      data-myoxus-ui-role="mermaid-state-actions"
    >
      {primary.map((action) =>
        action === "group" ? (
          <Tooltip
            key={action}
            content={props.groupAllowed ? m.stateGroup() : m.stateGroupHelp()}
          >
            <span>
              <StateActionPopover
                props={props}
                action={action}
                disabled={props.readonly || !props.groupAllowed}
              />
            </span>
          </Tooltip>
        ) : (
          <StateActionPopover
            key={action}
            props={props}
            action={action}
            disabled={
              props.readonly ||
              (action === "transition" &&
                !props.model.states.length &&
                !props.model.composites.length)
            }
          />
        ),
      )}
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
                    [
                      "emptyComposite",
                      "pseudostate",
                      "region",
                      "note",
                      "deleteSelection",
                    ].includes(action)
                  }
                  onSelect={() =>
                    action === "comments"
                      ? (setCommentsVisible(!commentsVisible),
                        props.onParentIntent("comments"))
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
        <StateActionPopover props={props} action={props.parentIntent} />
      ) : null}
    </Group>
  );
  const selected = props.selected;
  const selectedLabel = selected
    ? {
        state: m.stateLabel,
        description: m.stateDescription,
        transition: m.stateTransition,
        composite: m.stateComposite,
        region: m.stateRegion,
        note: m.sequenceNote,
        comment: m.visualComments,
        title: m.titlePlaceholder,
      }[selected.kind]()
    : undefined;
  const selectedEditButton = selected ? (
    <Button
      onClick={() =>
        props.onEditIntent({
          kind:
            selected.kind === "description"
              ? "detail"
              : selected.kind === "transition"
                ? "edge"
                : selected.kind === "composite"
                  ? "subgraph"
                  : "node",
          id: selected.key,
          ownerId: selected.ownerKey,
        })
      }
    >
      {selectedLabel}
    </Button>
  ) : null;
  const selectedForm =
    selected && props.intent ? (
      <StateObjectForm
        key={`form:${selected.kind}:${selected.key}`}
        props={props}
      />
    ) : null;
  const selectedControl =
    selected && !props.displayOnly ? (
      <Group key={`actions:${selected.kind}:${selected.key}`} wrap="nowrap">
        {props.surface === "controls" ? (
          <Popover
            fitViewport
            trapFocus
            contentMeasure="reading"
            opened={Boolean(props.intent)}
            onChange={(opened) => {
              if (!opened) props.onEditIntent(null);
            }}
          >
            <PopoverTarget>{selectedEditButton}</PopoverTarget>
            <PopoverContent
              aria-labelledby={undefined}
              aria-label={selectedLabel}
            >
              <Scrollable.Viewport autosize maxHeight="floating">
                {selectedForm}
              </Scrollable.Viewport>
            </PopoverContent>
          </Popover>
        ) : (
          selectedEditButton
        )}
        {selected.kind !== "title" ? (
          <StateCommentsPopover
            props={props}
            anchor={{
              anchorKind:
                selected.kind === "comment" ? "record" : selected.kind,
              anchorId: selected.key,
              position:
                selected.kind === "state" || selected.kind === "composite"
                  ? "after"
                  : "before",
            }}
          />
        ) : null}
      </Group>
    ) : null;
  const markers =
    commentsVisible && !props.displayOnly
      ? props.commentMarkers.map((marker) => (
          <Box
            key={marker.key}
            data-myoxus-ui-role="mermaid-state-comment-marker"
            pos={props.markersInClientSpace ? "fixed" : "absolute"}
            onPointerDown={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            style={{
              left: marker.left,
              top: marker.top,
              transform: "translate(-50%, -50%)",
              zIndex: "var(--myoxus-z-index-popover)",
            }}
          >
            <StateCommentsPopover
              props={props}
              anchor={marker.anchor}
              anchorLabel={marker.label}
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
            {m.visualPlaceShape(m.stateLabel())}
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
      <Popover
        key={`${selected?.kind}:${selected?.key}`}
        opened
        fitViewport
        contentMeasure={props.intent ? "reading" : undefined}
        position={
          props.intent
            ? "bottom"
            : selected?.kind === "transition"
              ? "right"
              : "top"
        }
        trapFocus={Boolean(props.intent)}
        closeOnEscape={Boolean(props.intent)}
        returnFocus={false}
        onChange={(opened) => {
          if (!opened && props.intent) props.onEditIntent(null);
        }}
      >
        <PopoverTarget>
          {/* This point is GFX geometry; Mantine owns the control's viewport fit. */}
          <Box
            pos="absolute"
            style={{
              left: props.selectedAnchor.left,
              top: props.selectedAnchor.top,
            }}
          />
        </PopoverTarget>
        <PopoverContent
          aria-labelledby={undefined}
          aria-label={selectedLabel}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {/* Actions and the active form share one measured floating surface. */}
          <Scrollable.Viewport autosize maxHeight="floating">
            <Stack>
              {selectedControl}
              {selectedForm}
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

function StateSelectionDelete({ props }: { props: StateReactHostProps }) {
  const d = useStateDraft({}, props);
  if (
    props.selected &&
    (props.selectedKeys.length === 1 || props.selected.kind === "description")
  )
    return (
      <StateObjectForm
        props={{
          ...props,
          onEditIntent: () => {
            props.onParentIntent(null);
            props.onCloseSelection();
          },
        }}
        initialDelete
      />
    );
  const trial = deleteStateSelection(props.model, props.selectedKeys),
    impact = trial.impact;
  return (
    <ConfirmModal
      open
      onOpenChange={(open) => {
        if (!open) props.onParentIntent(null);
      }}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      onConfirm={() => {
        const result = d.commit("deleteStateSelection", [props.selectedKeys]);
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
        {d.diagnostic || trial.diagnostic ? (
          <Alert color="myoxusError" role="alert">
            {d.diagnostic ?? trial.diagnostic}
          </Alert>
        ) : null}
      </Stack>
    </ConfirmModal>
  );
}
