// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import {
  Box,
  Button,
  Group,
  Stack,
  MyoxusText,
  Menu,
  MenuItem,
  Popover,
  PopoverTarget,
  PopoverContent,
  Scrollable,
  ConfirmModal,
  Alert,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  BLOCK_PARENT_ACTIONS,
  BLOCK_PARENT_ACTION_LABELS as labels,
  deleteBlockSelection,
  type BlockReactHostProps,
  type BlockParentAction,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import { useBlockSelection } from "./selection";
import { useBlockDraft } from "./drafts";
import { BlockInlineLabelForm, BlockForm } from "./block-popover";
import { BlockCompositeForm } from "./composite-popover";
import { BlockGridForm } from "./grid-popover";
import { BlockSpaceForm } from "./space-popover";
import { BlockConnectionForm } from "./connection-popover";
import { BlockCommentsForm, BlockCommentsPopover } from "./comment-popover";
import { BlockAppearanceForm } from "./appearance-popover";
import { BlockAccessibilityForm } from "./accessibility-popover";
import { BlockDiagramTitleForm } from "./diagram-settings";
import { BlockDataForm } from "./data-popover";
function BlockParentForm({
  props,
  action,
}: {
  props: BlockReactHostProps;
  action: BlockParentAction;
}) {
  const close = () => props.onParentIntent(null);
  switch (action) {
    case "addBlock":
      return <BlockForm props={props} onClose={close} />;
    case "emptyComposite":
      return <BlockCompositeForm props={props} onClose={close} />;
    case "group":
      return <BlockCompositeForm props={props} group onClose={close} />;
    case "space":
      return <BlockSpaceForm props={props} onClose={close} />;
    case "connection":
      return <BlockConnectionForm props={props} onClose={close} />;
    case "grid":
      return <BlockGridForm props={props} onClose={close} />;
    case "comments":
      return <BlockCommentsForm props={props} />;
    case "appearance":
      return <BlockAppearanceForm props={props} />;
    case "accessibility":
      return <BlockAccessibilityForm props={props} onClose={close} />;
    case "data":
      return <BlockDataForm props={props} />;
    case "deleteSelection":
      return <BlockSelectionDelete props={props} />;
  }
}
function BlockObjectForm({ props }: { props: BlockReactHostProps }) {
  const selected = props.selected,
    close = () => props.onEditIntent(null);
  if (!selected) return null;
  switch (selected.kind) {
    case "block":
      if (props.intent?.action !== "edit" || props.intent?.kind === "detail")
        return (
          <BlockInlineLabelForm
            props={props}
            nodeKey={selected.key}
            onClose={close}
          />
        );
      return (
        <BlockForm
          props={props}
          node={props.model.nodes.find((n) => n.sourceKey === selected.key)}
          onClose={close}
        />
      );
    case "composite":
      return (
        <BlockCompositeForm
          props={props}
          composite={props.model.groups.find(
            (n) => n.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
    case "space":
      return (
        <BlockSpaceForm
          props={props}
          space={props.model.spaces.find((n) => n.sourceKey === selected.key)}
          onClose={close}
        />
      );
    case "connection":
      return (
        <BlockConnectionForm
          props={props}
          connection={props.model.edges.find(
            (n) => n.sourceKey === selected.key,
          )}
          onClose={close}
        />
      );
    case "comment":
      return <BlockCommentsForm props={props} />;
    case "title":
      return <BlockDiagramTitleForm props={props} onClose={close} />;
  }
}
function BlockActionPopover({
  props,
  action,
  disabled = false,
}: {
  props: BlockReactHostProps;
  action: BlockParentAction;
  disabled?: boolean;
}) {
  return (
    <Popover
      fitViewport
      trapFocus
      contentMeasure="reading"
      opened={props.parentIntent === action}
      onChange={(open) => {
        if (!open) props.onParentIntent(null);
      }}
    >
      <PopoverTarget>
        <Button
          disabled={disabled}
          aria-label={labels[action]()}
          onClick={() =>
            props.onParentIntent(props.parentIntent === action ? null : action)
          }
        >
          {labels[action]()}
        </Button>
      </PopoverTarget>
      <PopoverContent aria-label={labels[action]()}>
        <Scrollable.Viewport autosize maxHeight="floating">
          {props.parentIntent === action ? (
            <BlockParentForm
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
export function MermaidBlockRuntimeEditor({
  props: inputProps,
}: {
  props: BlockReactHostProps;
}) {
  const props = useBlockSelection(inputProps),
    [commentsVisible, setCommentsVisible] = useState(false),
    [invisibleVisible, setInvisibleVisible] = useState(false),
    [sourceEdge, setSourceEdge] = useState<string | null>(null),
    primary = BLOCK_PARENT_ACTIONS.filter((a) =>
      ["addBlock", "emptyComposite", "space", "connection", "grid"].includes(a),
    ),
    more = BLOCK_PARENT_ACTIONS.filter((a) => !primary.includes(a));
  useEffect(() => {
    setSourceEdge(null);
  }, [props.sourceBasis, props.readonly, props.displayOnly]);
  const zeroSpaces = props.model.spaces.filter((s) => s.span === 0);
  const actions = (
    <Group
      aria-label={m.controlsLabel()}
      data-myoxus-ui-role="mermaid-block-actions"
    >
      {primary.map((action) => (
        <BlockActionPopover
          key={action}
          props={props}
          action={action}
          disabled={
            props.readonly ||
            (action === "connection" &&
              !props.model.nodes.length &&
              !props.model.groups.some((g) => g.explicitId))
          }
        />
      ))}
      <Menu
        title={m.visualMoreActions()}
        items={
          <>
            {more
              .filter(
                (a) => a !== "deleteSelection" || props.selectedKeys.length > 0,
              )
              .map((action) => (
                <MenuItem
                  key={action}
                  disabled={
                    (props.readonly &&
                      ["group", "deleteSelection"].includes(action)) ||
                    (action === "group" && !props.groupAllowed)
                  }
                  onSelect={() => {
                    if (action === "comments")
                      setCommentsVisible(!commentsVisible);
                    props.onParentIntent(action);
                  }}
                >
                  {labels[action]()}
                </MenuItem>
              ))}
            <MenuItem onSelect={() => setInvisibleVisible(!invisibleVisible)}>
              {m.blockGuides()}
            </MenuItem>
            {props.model.edges
              .filter((e) => !e.resolved || e.invisible)
              .map((e) => (
                <MenuItem
                  key={e.sourceKey}
                  onSelect={() => setSourceEdge(e.sourceKey)}
                >
                  {e.from} {e.token} {e.to}
                </MenuItem>
              ))}
          </>
        }
      >
        <Button>{m.visualMoreActions()}</Button>
      </Menu>
      {props.parentIntent && more.includes(props.parentIntent) ? (
        <BlockActionPopover props={props} action={props.parentIntent} />
      ) : null}
      {sourceEdge ? (
        <Popover
          opened
          fitViewport
          trapFocus
          contentMeasure="reading"
          onChange={(v) => {
            if (!v) setSourceEdge(null);
          }}
        >
          <PopoverTarget>
            <Button>{m.visualConnect()}</Button>
          </PopoverTarget>
          <PopoverContent>
            <Scrollable.Viewport autosize maxHeight="floating">
              <BlockConnectionForm
                props={props}
                connection={props.model.edges.find(
                  (e) => e.sourceKey === sourceEdge,
                )}
                onClose={() => setSourceEdge(null)}
              />
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
      ) : null}
    </Group>
  );
  const selected = props.selected,
    protectedBounds =
      selected?.kind === "block" && props.intent
        ? props.resolveVisualBounds?.("node", selected.key)
        : undefined,
    selectedLabel = selected
      ? {
          block: m.blockNode,
          composite: m.blockGroup,
          space: m.blockSpace,
          connection: m.visualConnect,
          comment: m.visualComments,
          title: m.titlePlaceholder,
        }[selected.kind]()
      : undefined;
  const selectedEdit =
    selected && !props.readonly ? (
      <Button
        onClick={() =>
          props.onEditIntent({
            action: "edit",
            kind:
              selected.kind === "connection"
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
    selected && props.intent && !props.readonly ? (
      <BlockObjectForm key={`${selected.kind}:${selected.key}`} props={props} />
    ) : null;
  const anchorKey = selected
    ? ([...props.model.nodes, ...props.model.groups].find(
        (n) => n.sourceKey === selected.key,
      )?.recordKeys[0] ?? selected.key)
    : undefined;
  const selectedControls =
    selected && !props.displayOnly ? (
      <Group wrap="nowrap">
        {props.surface === "controls" ? (
          <Popover
            fitViewport
            trapFocus
            contentMeasure="reading"
            opened={Boolean(props.intent)}
            onChange={(v) => {
              if (!v) props.onEditIntent(null);
            }}
          >
            <PopoverTarget>{selectedEdit}</PopoverTarget>
            <PopoverContent aria-label={selectedLabel}>
              <Scrollable.Viewport autosize maxHeight="floating">
                {selectedForm}
              </Scrollable.Viewport>
            </PopoverContent>
          </Popover>
        ) : (
          selectedEdit
        )}
        {selected.kind !== "title" ? (
          <BlockCommentsPopover props={props} anchorKey={anchorKey} />
        ) : null}
      </Group>
    ) : null;
  const controls =
    selectedControls && props.selectedAnchor ? (
      <Popover
        key={`${selected?.kind}:${selected?.key}`}
        opened
        fitViewport
        contentMeasure={props.intent ? "reading" : undefined}
        position={props.intent ? "bottom" : "top"}
        trapFocus={Boolean(props.intent)}
        closeOnEscape={Boolean(props.intent)}
        returnFocus={false}
        onChange={(v) => {
          if (!v && props.intent) props.onEditIntent(null);
        }}
      >
        <PopoverTarget>
          <Box
            pos="absolute"
            style={{
              left: protectedBounds?.left ?? props.selectedAnchor.left,
              top: protectedBounds?.top ?? props.selectedAnchor.top,
              // A renderer point needs a nonempty DOM rect for Floating UI's
              // clipping test; zero-sized references toggle hide/resize updates.
              // The full body keeps the notation preview clear of its form;
              // stroke/label actions retain their nonempty point reference.
              width: Math.max(1, protectedBounds?.width ?? 1),
              height: Math.max(1, protectedBounds?.height ?? 1),
            }}
          />
        </PopoverTarget>
        <PopoverContent
          aria-label={selectedLabel}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          <Stack>
            {selectedControls}
            {selectedForm ? (
              <Scrollable.Viewport autosize maxHeight="floating">
                {selectedForm}
              </Scrollable.Viewport>
            ) : null}
          </Stack>
        </PopoverContent>
      </Popover>
    ) : null;
  // These overlays contain only renderer geometry. The shared viewport supplies
  // all positions; the Facade owns each interactive marker and floating form.
  const markers =
    !props.displayOnly && !props.readonly ? (
      <>
        {props.model.spaces
          .filter((s) => s.span !== 0)
          .map((s) => {
            const b = props.resolveVisualBounds?.(
              "node",
              s.sourceKey,
              props.markersInClientSpace,
            );
            return b ? (
              <Box
                key={s.sourceKey}
                pos={props.markersInClientSpace ? "fixed" : "absolute"}
                style={{
                  left: b.left + b.width / 2,
                  // Free presentation can extend a neighbouring body into this
                  // Source slot. Keep the edit marker out of its label band.
                  top: b.top,
                  transform: "translateX(-50%)",
                  // Native button chrome must not steal a neighbouring body's
                  // hit region when the camera makes this Source slot smaller.
                  maxWidth: b.width,
                  maxHeight: b.height,
                  overflow: "hidden",
                }}
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Button
                  aria-label={`${m.blockSpace()} · ${s.span}`}
                  disabled={props.readonly}
                  onClick={() => {
                    props.selectObject?.("node", s.sourceKey);
                    props.onEditIntent({ kind: "node", id: s.sourceKey });
                  }}
                >
                  {m.blockSpace()} · {s.span}
                </Button>
              </Box>
            ) : null;
          })}
        {zeroSpaces.map((s, index) => {
          const bounds = props.resolveVisualBounds?.(
            "node",
            s.sourceKey,
            props.markersInClientSpace,
          );
          if (!bounds || props.readonly) return null;
          const prior = zeroSpaces.slice(0, index).some((p) => {
            const b = props.resolveVisualBounds?.(
              "node",
              p.sourceKey,
              props.markersInClientSpace,
            );
            return b && b.left === bounds.left && b.top === bounds.top;
          });
          if (prior) return null;
          const siblings = zeroSpaces.filter((p) => {
            const b = props.resolveVisualBounds?.(
              "node",
              p.sourceKey,
              props.markersInClientSpace,
            );
            return b && b.left === bounds.left && b.top === bounds.top;
          });
          return (
            <Box
              key={s.sourceKey}
              pos={props.markersInClientSpace ? "fixed" : "absolute"}
              style={{
                left: bounds.left,
                top: bounds.top,
                transform: "translateY(-100%)",
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <Group wrap="nowrap">
                {siblings.map((z) => (
                  <Button
                    key={z.sourceKey}
                    aria-label={`${m.blockSpace()} · 0 · ${z.order + 1}`}
                    onClick={() => {
                      props.selectObject?.("node", z.sourceKey);
                      props.onEditIntent({ kind: "node", id: z.sourceKey });
                    }}
                  >
                    {m.blockSpace()} · 0
                  </Button>
                ))}
              </Group>
            </Box>
          );
        })}
        {commentsVisible
          ? props.commentMarkers
              .filter(
                (marker, index, all) =>
                  !all
                    .slice(0, index)
                    .some(
                      (p) => p.left === marker.left && p.top === marker.top,
                    ),
              )
              .map((marker) => (
                <Box
                  key={marker.key}
                  pos={props.markersInClientSpace ? "fixed" : "absolute"}
                  style={{
                    left: marker.left,
                    top: marker.top,
                    transform: "translate(-50%, -50%)",
                    zIndex: "var(--myoxus-z-index-popover)",
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <Group wrap="nowrap">
                    {props.commentMarkers
                      .filter(
                        (p) => p.left === marker.left && p.top === marker.top,
                      )
                      .map((p) => (
                        <BlockCommentsPopover
                          key={p.key}
                          props={props}
                          marker
                          commentKey={p.key}
                          count={p.count}
                          anchorKey={p.anchorKey}
                        />
                      ))}
                  </Group>
                </Box>
              ))
          : null}
        {invisibleVisible
          ? props.model.edges
              .filter((e) => e.invisible)
              .map((e) => {
                const b = props.resolveVisualBounds?.(
                  "edge",
                  e.sourceKey,
                  props.markersInClientSpace,
                );
                return b ? (
                  <Box
                    key={e.sourceKey}
                    pos={props.markersInClientSpace ? "fixed" : "absolute"}
                    style={{
                      left: b.left + b.width / 2,
                      top: b.top + b.height / 2,
                    }}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <Button
                      disabled={props.readonly}
                      onClick={() => setSourceEdge(e.sourceKey)}
                    >
                      {e.from} · {e.to}
                    </Button>
                  </Box>
                ) : null;
              })
          : null}
        <BlockGridGuides props={props} />
      </>
    ) : null;
  if (props.surface === "controls")
    return (
      <Group
        onPointerDown={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {actions}
        {props.placementPending ? (
          <MyoxusText role="status">
            {m.visualPlaceShape(m.blockNode())}
          </MyoxusText>
        ) : null}
        {selectedControls}
        {typeof document !== "undefined"
          ? createPortal(markers, document.body)
          : null}
      </Group>
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
        props.visualModel.accessibilityTitle || m.controlsLabel()
      }
      workareaAccessibilityDescription={
        props.visualModel.accessibilityDescription
      }
    />
  );
}
function groupGeometryWidth(props: BlockReactHostProps, key: string) {
  return props.visualModel.subgraphs?.find((g) => g.id === key)?.width ?? 1;
}
function BlockGridGuides({ props }: { props: BlockReactHostProps }) {
  return (
    <>
      {[null, ...props.model.groups].map((group) => {
        const b = group
          ? props.resolveVisualBounds?.(
              "subgraph",
              group.sourceKey,
              props.markersInClientSpace,
            )
          : undefined;
        const children = props.visualModel.nodes.filter(
          (n) =>
            n.familyData?.payload.binding &&
            (n.familyData.payload.binding as { parentKey: string | null })
              .parentKey === (group?.bodyKey ?? null),
        );
        const childBounds = children.flatMap((n) => {
          const r = props.resolveVisualBounds?.(
            "node",
            n.id,
            props.markersInClientSpace,
          );
          return r ? [r] : [];
        });
        const left = b?.left ?? Math.min(...childBounds.map((r) => r.left)),
          top = b?.top ?? Math.min(...childBounds.map((r) => r.top));
        if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
        const columns = group?.columns ?? props.model.columns;
        const scale =
          group && b
            ? b.width / groupGeometryWidth(props, group.sourceKey)
            : children.length && childBounds.length
              ? childBounds[0]!.width / children[0]!.width
              : 1;
        const projection = group
          ? props.visualModel.subgraphs?.find((g) => g.id === group.sourceKey)
              ?.familyData?.payload
          : undefined;
        const captionY = group
          ? (Number(projection?.headerHeight) -
              Number(projection?.padding) / 2) *
            scale
          : -22 * scale;
        return (
          <svg
            key={group?.sourceKey ?? "root"}
            aria-hidden
            width={1}
            height={1}
            style={{
              position: props.markersInClientSpace ? "fixed" : "absolute",
              left,
              top,
              pointerEvents: "none",
              overflow: "visible",
            }}
          >
            <text
              x={0}
              y={captionY}
              fill="var(--myoxus-text-secondary-color)"
              fontFamily="var(--myoxus-typography-body-family)"
              fontSize="var(--myoxus-typography-body-size)"
            >
              {group ? "" : `${m.chartRoot()} · `}
              {m.blockColumns()} {columns === -1 ? m.radarAutomatic() : columns}
            </text>
          </svg>
        );
      })}
      {props.visualModel.nodes.map((n) => {
        const data = n.familyData?.payload,
          b = props.resolveVisualBounds?.(
            "node",
            n.id,
            props.markersInClientSpace,
          );
        if (!b) return null;
        // Guides follow renderer bounds, while their captions remain readable
        // screen annotations at both Page and native camera zoom levels.
        const scale = b.width / n.width;
        return (
          <svg
            key={n.id}
            data-mermaid-grid-key={n.id}
            aria-hidden="true"
            width={b.width}
            height={b.height}
            viewBox={`0 0 ${n.width} ${n.height}`}
            style={{
              position: props.markersInClientSpace ? "fixed" : "absolute",
              left: b.left,
              top: b.top,
              pointerEvents: "none",
              overflow: "visible",
              color: "var(--myoxus-border-color)",
            }}
          >
            <rect
              width={n.width}
              height={n.height}
              fill="none"
              stroke="currentColor"
              strokeDasharray="3 5"
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={0}
              y={
                props.surface === "controls" ||
                (data?.binding as { parentKey?: string | null } | undefined)
                  ?.parentKey
                  ? 14 / scale
                  : -4 / scale
              }
              fill="var(--myoxus-text-secondary-color)"
              fontFamily="var(--myoxus-typography-body-family)"
              fontSize={`calc(var(--myoxus-typography-body-size) / ${scale})`}
            >
              {Number(data?.row) + 1}.{Number(data?.column) + 1} · ↔
              {String(data?.span)}
              {typeof data?.gridX === "number" &&
              (Math.abs(n.x - Number(data?.gridX)) > 1 ||
                Math.abs(n.y - Number(data?.gridY)) > 1)
                ? ` · ${m.visualMovedKanban()}`
                : ""}
            </text>
          </svg>
        );
      })}
    </>
  );
}
function BlockSelectionDelete({ props }: { props: BlockReactHostProps }) {
  const d = useBlockDraft({}, props),
    trial = deleteBlockSelection(props.model, props.selectedKeys);
  return (
    <ConfirmModal
      open
      onOpenChange={(v) => {
        if (!v) props.onParentIntent(null);
      }}
      title={m.visualDelete()}
      confirmText={m.visualDelete()}
      onConfirm={() => {
        if (
          !d.commit("deleteBlockSelection", [props.selectedKeys]).diagnostic
        ) {
          props.onParentIntent(null);
          props.onCloseSelection();
        }
      }}
    >
      <Stack>
        {trial.impact.records.map((r) => (
          <MyoxusText key={r.id}>{r.label}</MyoxusText>
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
