// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { createPortal } from "react-dom";
import { useErSelection } from "./selection";
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
  ER_PARENT_ACTIONS,
  ER_PARENT_ACTION_LABELS as labels,
  type ErParentAction,
  type ErReactHostProps,
  deleteErSelection,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { ErEntityForm } from "./entity-popover";
import {
  ErAddAttributePopover,
  ErAttributeForm,
  ErAttributeReorderHandle,
} from "./attribute-popover";
import { ErRelationshipForm } from "./relationship-popover";
import { ErSubgraphForm } from "./subgraph-popover";
import { ErCommentsForm, ErCommentsPopover } from "./comment-popover";
import { ErAppearanceForm } from "./appearance-popover";
import {
  ErAccessibilityForm,
  ErDiagramTitleForm,
} from "./accessibility-popover";
import { useErDraft } from "./drafts";
import { ErDataForm } from "./data-popover";
function ErParentForm({
  props,
  action,
}: {
  props: ErReactHostProps;
  action: ErParentAction;
}) {
  const close = () => props.onParentIntent(null);
  switch (action) {
    case "addEntity":
      return <ErEntityForm props={props} onClose={close} />;
    case "attribute":
      return (
        <ErAttributeForm
          props={props}
          entityKey={props.selected?.ownerKey ?? props.selected?.key ?? ""}
          onClose={close}
        />
      );
    case "connect":
      return <ErRelationshipForm props={props} onClose={close} />;
    case "group":
      return <ErSubgraphForm props={props} group onClose={close} />;
    case "emptySubgraph":
      return <ErSubgraphForm props={props} onClose={close} />;
    case "comments":
      return <ErCommentsForm props={props} />;
    case "appearance":
      return <ErAppearanceForm props={props} onClose={close} />;
    case "accessibility":
      return <ErAccessibilityForm props={props} onClose={close} />;
    case "data":
      return <ErDataForm props={props} />;
    case "deleteSelection":
      return <ErSelectionDelete props={props} />;
  }
}
function ErObjectForm({ props }: { props: ErReactHostProps }) {
  const selected = props.selected,
    close = () => props.onEditIntent(null);
  if (!selected) return null;
  switch (selected.kind) {
    case "title":
      return <ErDiagramTitleForm props={props} onClose={close} />;
    case "entity":
      return (
        <ErEntityForm
          props={props}
          node={props.model.entities.find((n) => n.sourceKey === selected.key)}
          onClose={close}
        />
      );
    case "attribute": {
      const owner = props.model.entities.find((n) =>
          n.attributes.some((member) => member.id === selected.key),
        ),
        member = owner?.attributes.find((member) => member.id === selected.key);
      return owner && member ? (
        <ErAttributeForm
          props={props}
          entityKey={owner.sourceKey}
          attribute={member}
          onClose={close}
        />
      ) : null;
    }
    case "relation":
      return (
        <ErRelationshipForm
          props={props}
          relation={props.model.relationships.find(
            (r) => r.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
    case "subgraph":
      return (
        <ErSubgraphForm
          props={props}
          subgraph={props.model.subgraphs.find(
            (n) => n.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
  }
}
function ErActionPopover({
  props,
  action,
  disabled = false,
}: {
  props: ErReactHostProps;
  action: ErParentAction;
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
              ? `${labels[action]()}. ${m.erInvalidMembership()}`
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
            <ErParentForm
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
export function MermaidErRuntimeEditor({
  props: inputProps,
}: {
  props: ErReactHostProps;
}) {
  const props = useErSelection(inputProps);
  const [commentsVisible, setCommentsVisible] = useState(false);
  const primary = ER_PARENT_ACTIONS.filter((a) =>
      ["addEntity", "connect", "attribute", "group"].includes(a),
    ),
    more = ER_PARENT_ACTIONS.filter((a) => !primary.includes(a));
  const actions = (
    <Group
      aria-label={m.controlsLabel()}
      data-myoxus-ui-role="mermaid-er-actions"
    >
      {primary.map((action) =>
        action === "group" ? (
          <Tooltip
            key={action}
            content={props.groupAllowed ? m.erGroup() : m.erInvalidMembership()}
          >
            <span>
              <ErActionPopover
                props={props}
                action={action}
                disabled={props.readonly || !props.groupAllowed}
              />
            </span>
          </Tooltip>
        ) : (
          <ErActionPopover
            key={action}
            props={props}
            action={action}
            disabled={
              props.readonly ||
              (action === "connect" && !props.model.entities.length) ||
              (action === "attribute" &&
                !["entity", "attribute"].includes(props.selected?.kind ?? ""))
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
                    ["emptySubgraph", "deleteSelection"].includes(action)
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
        <ErActionPopover props={props} action={props.parentIntent} />
      ) : null}
    </Group>
  );
  const selected = props.selected;
  const selectedLabel = selected
    ? selected.kind === "attribute"
      ? m.classAttribute()
      : selected.kind === "entity"
        ? m.erEntityId()
        : selected.kind === "subgraph"
          ? m.erSubgraph()
          : selected.kind === "relation"
            ? m.erRelationship()
            : m.titlePlaceholder()
    : undefined;
  const selectedEditButton = selected ? (
    <Button
      onClick={() =>
        props.onEditIntent({
          kind:
            selected.kind === "attribute"
              ? "detail"
              : selected.kind === "relation"
                ? "edge"
                : selected.kind === "subgraph"
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
      <ErObjectForm
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
        {selected.kind === "entity" || selected.kind === "attribute" ? (
          <ErAddAttributePopover
            props={props}
            entityKey={selected.ownerKey ?? selected.key}
          />
        ) : null}
        {selected.kind !== "title" ? (
          <ErCommentsPopover
            props={props}
            anchor={{
              anchorKind: selected.kind,
              anchorId: selected.key,
              position:
                selected.kind === "entity" || selected.kind === "subgraph"
                  ? "after"
                  : "before",
            }}
          />
        ) : null}
      </Group>
    ) : null;
  const selectedAttribute =
    selected?.kind === "attribute"
      ? props.model.entities
          .flatMap((e) => e.attributes.map((a) => ({ a, entity: e })))
          .find((v) => v.a.id === selected.key)
      : null;
  const reorderHandle = selectedAttribute ? (
    <ErAttributeReorderHandle
      props={props}
      attribute={selectedAttribute.a}
      entityKey={selectedAttribute.entity.sourceKey}
    />
  ) : null;
  const markers = commentsVisible
    ? props.commentMarkers.map((marker) => (
        <Box
          key={marker.key}
          data-myoxus-ui-role="mermaid-er-comment-marker"
          pos={props.markersInClientSpace ? "fixed" : "absolute"}
          onPointerDown={(event) => event.stopPropagation()}
          style={{
            left: marker.left,
            top: marker.top,
            transform: "translate(-50%, -50%)",
            zIndex: "var(--myoxus-z-index-popover)",
          }}
        >
          <ErCommentsPopover
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
            {m.visualPlaceShape(m.erEntity())}
          </MyoxusText>
        ) : null}
        {selectedControl}
        {reorderHandle}
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
        position={props.intent ? "bottom" : "top"}
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
          {reorderHandle}
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

function ErSelectionDelete({ props }: { props: ErReactHostProps }) {
  const d = useErDraft({}, props);
  const impact = deleteErSelection(props.model, props.selectedKeys).impact;
  return (
    <ConfirmModal
      open
      onOpenChange={(open) => {
        if (!open) props.onParentIntent(null);
      }}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      onConfirm={() => {
        const result = d.commit("deleteErSelection", [props.selectedKeys]);
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
        {d.diagnostic ? (
          <Alert color="myoxusError" role="alert">
            {d.diagnostic}
          </Alert>
        ) : null}
      </Stack>
    </ConfirmModal>
  );
}
