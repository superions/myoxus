// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@myoxus/i18n";
import { MindmapCommentsPopover } from "./comment-popover";
import { MindmapNodeHandles } from "./node-handles";
import {
  Box,
  IconButton,
  IconButtonGroup,
  Button,
  Group,
  MyoxusText,
  Stack,
  Scrollable,
  Popover,
  PopoverContent,
  PopoverTarget,
  Menu,
  MenuItem,
  notify,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as m,
  mindmapControlActions,
  bindMindmapDrag,
  bindMindmapClipboard,
  copyMindmapSelection,
  pasteMindmapSelection,
  mindmapIntentFromObjectEdit,
  type MindmapEditIntent,
  type MindmapDragFeedback,
  type MindmapReactHostProps,
  type MindmapLabelActionsProps,
} from "@virgultum/block-mermaid";
import { MermaidGfxEditorWorkbench } from "../mermaid-editor-workbench";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import {
  DownloadIcon,
  TrashIcon,
  SubNodeIcon,
  SiblingNodeIcon,
  EditIcon,
  MoveToIcon,
  CollapseIcon,
  ExpandIcon,
  SettingsIcon,
  LayoutIcon,
  ImportIcon,
  CommentIcon,
  UndoIcon,
  RedoIcon,
  LocateIcon,
  MoreHorizontalIcon,
  CopyIcon,
  PasteIcon,
} from "@myoxus/icons";
import { MindmapDeleteConfirmation } from "./delete-confirmation";
import { MindmapImportForm } from "./import-popover";
import { MindmapLayoutForm } from "./layout-popover";
import { MindmapMoveForm } from "./move-popover";
import { MindmapNodeForm } from "./node-popover";

export function MermaidMindmapRuntimeEditor({
  props,
}: {
  props: MindmapReactHostProps;
}) {
  const t = useI18n();
  const [, refreshHistory] = useState(0);
  useEffect(
    () =>
      props.history?.subscribe?.(() =>
        refreshHistory((revision) => revision + 1),
      ),
    [props.history],
  );
  const emptyAction = useRef<HTMLButtonElement | null>(null);
  // Native selection switches from the deleted child to its empty owner and
  // can remount this consumer. The empty action remains the keyboard target.
  const focusEmpty = useRef(props.model.nodes.length === 0);
  useEffect(() => {
    if (
      focusEmpty.current &&
      !props.model.nodes.length &&
      !props.readonly &&
      !props.displayOnly
    ) {
      const frame = requestAnimationFrame(() =>
        emptyAction.current?.focus({ preventScroll: true }),
      );
      return () => cancelAnimationFrame(frame);
    }
    return undefined;
  }, [props.model.nodes.length, props.readonly, props.displayOnly]);
  const [nativeIntent, setNativeIntent] = useState<MindmapEditIntent | null>(
    null,
  );
  const [temporaryExpanded, setTemporaryExpanded] = useState(false);
  const readonlyPreview = useRef<(() => void) | null>(null);
  const collapseBasis = JSON.stringify([
    props.projection.layout,
    props.projection.design,
    [...(props.projection.collapsed ?? [])],
    [...(props.projection.rootSides ?? [])],
    [...(props.projection.nodeAppearance ?? [])],
    [...(props.projection.branchAppearance ?? [])],
  ]);
  useEffect(() => {
    setTemporaryExpanded(false);
    return () => {
      readonlyPreview.current?.();
      readonlyPreview.current = null;
    };
  }, [props.sourceBasis, props.readonly, collapseBasis]);
  const [commentsVisible, setCommentsVisible] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [dragFeedback, setDragFeedback] = useState<MindmapDragFeedback | null>(
    null,
  );
  const dragProps = useRef(props);
  const clipboardRevision = useRef(0);
  const [clipboardPending, setClipboardPending] = useState(false);
  dragProps.current = {
    ...props,
    intent: props.surface === "controls" ? nativeIntent : props.intent,
  };
  useEffect(() => {
    setClipboardPending(false);
    const dispose = bindMindmapClipboard(() => dragProps.current);
    return () => {
      clipboardRevision.current++;
      dispose?.();
    };
  }, [props.clipboard]);
  const copySelection = async () => {
    const revision = clipboardRevision.current;
    setClipboardPending(true);
    try {
      const write = copyMindmapSelection(dragProps.current);
      if (!write) return;
      await write;
      if (revision === clipboardRevision.current)
        notify.success(t["Copied to clipboard"]());
    } catch {
      if (revision === clipboardRevision.current)
        notify.error(t["com.myoxus.editor.clipboard.copy-failed"]());
    } finally {
      if (revision === clipboardRevision.current) setClipboardPending(false);
    }
  };
  const pasteSelection = async () => {
    const base = dragProps.current;
    const revision = clipboardRevision.current;
    if (!base.clipboard?.readCurrent) return;
    setClipboardPending(true);
    try {
      const data = await base.clipboard.readCurrent();
      const current = dragProps.current;
      // Clipboard permission UI is asynchronous. Never apply to a changed or
      // disposed owner, a different parent, or a newer Source basis afterward.
      if (revision !== clipboardRevision.current) return;
      if (
        current.sourceBasis !== base.sourceBasis ||
        current.selectedKeys.length !== 1 ||
        current.selectedKeys[0] !== base.selectedKeys[0]
      ) {
        notify.error(t["com.myoxus.common.operation-failed"]());
        return;
      }
      if (!pasteMindmapSelection(current, data))
        notify.error(t["com.myoxus.editor.clipboard.paste-unavailable"]());
    } catch {
      notify.error(t["com.myoxus.common.operation-failed"]());
    } finally {
      if (revision === clipboardRevision.current) setClipboardPending(false);
    }
  };
  const dragEnabled =
    !props.readonly && !props.displayOnly && Boolean(props.drag);
  const dragViewport = props.drag?.viewportIdentity;
  useEffect(
    () =>
      dragEnabled
        ? bindMindmapDrag(
            () => dragProps.current,
            setDragActive,
            setDragFeedback,
          )
        : undefined,
    [dragEnabled, dragViewport, props.sourceBasis],
  );
  const {
    subscribeEditIntent,
    readonly: readonlyHost,
    onIntent: editIntent,
  } = props;
  const intent = props.surface === "controls" ? nativeIntent : props.intent;
  const onIntent =
    props.surface === "controls"
      ? (value: MindmapEditIntent | null) => {
          if (
            value &&
            value.type !== "layout" &&
            value.type !== "import" &&
            value.type !== "properties" &&
            value.type !== "move" &&
            value.type !== "delete"
          ) {
            setNativeIntent(null);
            props.onIntent(value);
          } else setNativeIntent(value);
        }
      : props.onIntent;
  const close = () => {
    onIntent(null);
    if (props.surface === "controls")
      props.resolveReturnFocusTarget()?.focus({ preventScroll: true });
  };
  useEffect(() => {
    setNativeIntent(null);
  }, [props.selectedKey, props.sourceBasis, props.readonly]);
  useEffect(
    () =>
      subscribeEditIntent?.((next) => {
        if (readonlyHost || next.kind !== "node") return;
        if (next.action === "duplicate") {
          const current = dragProps.current;
          current.onIntent({
            type: "duplicate",
            keys: current.selectedKeys.length
              ? current.selectedKeys
              : [next.id],
          });
          return;
        }
        if (next.action === "delete") {
          setNativeIntent({
            type: "delete",
            keys: dragProps.current.selectedKeys.length
              ? dragProps.current.selectedKeys
              : [next.id],
          });
          return;
        }
        setNativeIntent(null);
        const edit = mindmapIntentFromObjectEdit(next);
        if (edit) editIntent(edit);
      }),
    [subscribeEditIntent, readonlyHost, editIntent],
  );
  const disabled = props.readonly || props.displayOnly;
  const entries = mindmapControlActions(
    props.model,
    props.selectedKey,
    disabled,
    onIntent,
    props.projection.collapsed,
  );
  const readonlyExploration =
    props.readonly && props.projection.collapsed?.size ? (
      <Group>
        <Button
          onClick={() => {
            readonlyPreview.current?.();
            readonlyPreview.current = null;
            if (!temporaryExpanded)
              readonlyPreview.current = props.onPreviewCollapsed(new Set());
            setTemporaryExpanded(!temporaryExpanded);
          }}
        >
          {temporaryExpanded ? m.collapse() : m.expand()}
        </Button>
      </Group>
    ) : null;
  // The same compact commands leave the tree visible in Page and canvas hosts.
  const actionIcons = new Map([
    ["mindmap.add-child", SubNodeIcon],
    ["mindmap.add-sibling", SiblingNodeIcon],
    ["mindmap.rename", EditIcon],
    ["mindmap.move", MoveToIcon],
    [
      "mindmap.collapse",
      props.projection.collapsed?.has(props.selectedKey ?? "")
        ? ExpandIcon
        : CollapseIcon,
    ],
    ["mindmap.properties", SettingsIcon],
    ["mindmap.layout", LayoutIcon],
    ["mindmap.import", ImportIcon],
  ]);
  const controls = (
    <>
      {readonlyExploration}
      {props.history && (props.embedded || props.surface === "controls") ? (
        <IconButtonGroup
          aria-label={`${t.Undo()} / ${t["com.myoxus.editor.keyboard.redo"]()}`}
        >
          <IconButton
            aria-label={t.Undo()}
            tooltip={t.Undo()}
            icon={<UndoIcon />}
            disabled={disabled || !props.history.canUndo}
            onClick={props.history.onUndo}
          />
          <IconButton
            aria-label={t["com.myoxus.editor.keyboard.redo"]()}
            tooltip={t["com.myoxus.editor.keyboard.redo"]()}
            icon={<RedoIcon />}
            disabled={disabled || !props.history.canRedo}
            onClick={props.history.onRedo}
          />
        </IconButtonGroup>
      ) : null}
      {props.onFitViewport ? (
        <IconButton
          aria-label={t["com.myoxus.editor.zoom.fit-to-screen"]()}
          tooltip={t["com.myoxus.editor.zoom.fit-to-screen"]()}
          icon={<LocateIcon />}
          onClick={props.onFitViewport}
        />
      ) : null}
      {entries.map((action) => {
        const opened = Boolean(
          action.intent &&
          intent &&
          intent.type === action.intent.type &&
          ((intent.type !== "properties" && intent.type !== "move") ||
            props.surface === "controls"),
        );
        const Icon = actionIcons.get(action.id);
        return (
          <Popover
            key={action.id}
            position={
              action.intent?.type === "properties" ||
              action.intent?.type === "move"
                ? "left"
                : props.embedded
                  ? "top"
                  : undefined
            }
            contentMeasure={
              action.intent?.type === "layout" ||
              action.intent?.type === "import"
                ? "reading"
                : undefined
            }
            opened={opened}
            closeOnEscape={
              intent?.type === "move" ||
              intent?.type === "layout" ||
              intent?.type === "properties"
                ? false
                : undefined
            }
            fitViewport
            trapFocus
            returnFocus={false}
            onChange={(value) => {
              if (!value) close();
            }}
          >
            <PopoverTarget>
              {Icon ? (
                <IconButton
                  icon={<Icon />}
                  aria-label={action.label}
                  tooltip={action.disabledReason ?? action.label}
                  title={action.disabledReason ?? action.label}
                  disabled={action.disabled}
                  aria-keyshortcuts={
                    action.id === "mindmap.collapse" ? "F9" : undefined
                  }
                  onClick={action.onSelect}
                />
              ) : (
                <Button
                  ref={
                    action.id === "mindmap.add-root" ? emptyAction : undefined
                  }
                  data-mermaid-empty-action={
                    action.id === "mindmap.add-root" || undefined
                  }
                  disabled={action.disabled}
                  title={action.disabledReason}
                  aria-keyshortcuts={
                    action.id === "mindmap.collapse" ? "F9" : undefined
                  }
                  onClick={action.onSelect}
                >
                  {action.label}
                </Button>
              )}
            </PopoverTarget>
            <PopoverContent
              aria-label={action.label}
              onPointerDown={(event) => event.stopPropagation()}
            >
              {opened && intent?.type === "import" ? (
                <Scrollable.Viewport autosize maxHeight="floating">
                  <MindmapImportForm props={props} onClose={close} />
                </Scrollable.Viewport>
              ) : opened && intent?.type === "layout" ? (
                <Scrollable.Viewport autosize maxHeight="floating">
                  <MindmapLayoutForm props={props} onClose={close} />
                </Scrollable.Viewport>
              ) : opened && intent?.type === "move" ? (
                <MindmapMoveForm
                  props={props}
                  nodeKey={intent.key}
                  onClose={close}
                />
              ) : opened && intent?.type === "properties" ? (
                <MindmapNodeForm
                  props={props}
                  intent={intent}
                  onClose={close}
                />
              ) : null}
            </PopoverContent>
          </Popover>
        );
      })}
      <Menu
        title={m.visualMoreActions()}
        items={
          <>
            <MenuItem
              prefixIcon={<CopyIcon />}
              disabled={
                clipboardPending ||
                props.draftActive ||
                !props.clipboard ||
                !props.selectedKeys.length
              }
              onSelect={() => void copySelection()}
            >
              {t.Copy()}
            </MenuItem>
            <MenuItem
              prefixIcon={<PasteIcon />}
              disabled={
                disabled ||
                clipboardPending ||
                props.draftActive ||
                !props.clipboard?.readCurrent ||
                props.selectedKeys.length !== 1
              }
              onSelect={() => void pasteSelection()}
            >
              {t["com.myoxus.context-menu.paste"]()}
            </MenuItem>
            <MenuItem
              prefixIcon={<CopyIcon />}
              disabled={
                disabled ||
                clipboardPending ||
                props.draftActive ||
                !props.selectedKeys.length
              }
              onSelect={() =>
                onIntent({ type: "duplicate", keys: props.selectedKeys })
              }
            >
              {t["com.myoxus.editor.keyboard.duplicate"]()}
            </MenuItem>
          </>
        }
      >
        <IconButton
          aria-label={m.visualMoreActions()}
          tooltip={m.visualMoreActions()}
          icon={<MoreHorizontalIcon />}
        />
      </Menu>
      <IconButton
        aria-label={m.visualComments()}
        tooltip={m.visualComments()}
        icon={<CommentIcon />}
        aria-pressed={commentsVisible}
        onClick={() => setCommentsVisible(!commentsVisible)}
      />
      {props.surface === "controls" || props.embedded ? (
        <IconButton
          aria-label={m.visualDelete()}
          icon={<TrashIcon />}
          disabled={disabled || !props.selectedKeys.length}
          onClick={() => {
            if (props.selectedKeys.length)
              onIntent({ type: "delete", keys: props.selectedKeys });
          }}
        />
      ) : null}
      <MindmapCommentsPopover props={props} />
      {props.embedded && props.onExportMmd ? (
        <IconButton
          aria-label={m.mmdExport()}
          icon={<DownloadIcon />}
          onClick={props.onExportMmd}
        />
      ) : null}
    </>
  );
  const actions = props.embedded ? (
    controls
  ) : (
    <Group
      aria-label={m.controlsLabel()}
      data-myoxus-ui-role="mermaid-mindmap-actions"
    >
      {controls}
    </Group>
  );
  const markers =
    !props.displayOnly && commentsVisible && !dragActive
      ? props.commentMarkers?.map((marker) => (
          <Box
            key={marker.key}
            pos={props.markersInClientSpace ? "fixed" : "absolute"}
            data-myoxus-ui-role="mermaid-mindmap-comment-marker"
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
            <MindmapCommentsPopover
              props={props}
              sourceKeys={marker.sourceKeys}
            />
          </Box>
        ))
      : null;
  const dropFeedback = dragFeedback ? (
    <Popover opened position="bottom-start" fitViewport returnFocus={false}>
      <PopoverTarget>
        {/* A pointer position is renderer geometry; Floating owns collision handling. */}
        <Box
          pos="fixed"
          style={{ left: dragFeedback.left, top: dragFeedback.top }}
        />
      </PopoverTarget>
      <PopoverContent
        aria-live="polite"
        data-mindmap-drop-kind={dragFeedback.kind}
        style={{ pointerEvents: "none" }}
      >
        <Stack>
          <MyoxusText>
            {m.mindmapMoveImpact(
              dragFeedback.impact.nodes,
              dragFeedback.impact.comments,
              dragFeedback.impact.decorations,
              dragFeedback.impact.parent,
            )}
          </MyoxusText>
          <MyoxusText>
            {dragFeedback.anchor
              ? `${dragFeedback.position === "after" ? m.sequenceAfter() : m.sequenceBefore()} · ${dragFeedback.anchor}`
              : m.mindmapMoveEnd()}
          </MyoxusText>
        </Stack>
      </PopoverContent>
    </Popover>
  ) : null;
  const deleteConfirmation = (
    <MindmapDeleteConfirmation
      props={props}
      nodeKeys={intent?.type === "delete" ? intent.keys : null}
      onClose={close}
      onDeleting={(root) => {
        focusEmpty.current = root;
      }}
      resolveReturnFocus={() =>
        emptyAction.current ?? props.resolveReturnFocusTarget()
      }
    />
  );
  if (props.surface === "controls")
    return (
      <Group
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
      >
        {actions}
        {deleteConfirmation}
        {createPortal(
          <>
            {markers}
            {dropFeedback}
            <MindmapNodeHandles
              props={{
                ...props,
                intent,
                draftActive: props.draftActive || dragActive,
              }}
            />
          </>,
          document.body,
        )}
      </Group>
    );
  const selectedControls =
    !props.displayOnly &&
    props.selectedAnchor &&
    props.selectedKey &&
    (intent?.type === "properties" || intent?.type === "move") ? (
      <Popover
        key={props.selectedKey}
        position={props.selectedAnchorSide ?? "left"}
        opened
        closeOnEscape={false}
        fitViewport
        trapFocus
        returnFocus={false}
        onChange={(opened) => {
          if (!opened) close();
        }}
      >
        <PopoverTarget>
          {/* GFX supplies the anchor; Mantine owns floating control layout. */}
          <Box
            pos="absolute"
            style={{
              left: props.selectedAnchor.left,
              top: props.selectedAnchor.top,
            }}
          />
        </PopoverTarget>
        <PopoverContent
          aria-label={m.selectedNodeLabel()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {intent.type === "move" ? (
            <MindmapMoveForm
              props={props}
              nodeKey={intent.key}
              onClose={close}
            />
          ) : (
            <MindmapNodeForm props={props} intent={intent} onClose={close} />
          )}
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
      selectionKey={props.selectedKeys.join("|")}
      onEscape={() => {
        if (!intent) return false;
        close();
        return true;
      }}
      onWorkareaResize={props.onWorkareaResize}
      onEmbeddedActionsInsetChange={props.onEmbeddedActionsInsetChange}
      resolveReturnFocusTarget={props.resolveReturnFocusTarget}
      embeddedActions={
        props.embedded && props.embeddedEditing && !props.displayOnly ? (
          <MermaidEmbeddedActions
            actions={actions}
            label={m.controlsLabel()}
            concealed={props.draftActive}
          />
        ) : null
      }
      toolbar={
        props.embedded
          ? null
          : props.displayOnly
            ? readonlyExploration
            : actions
      }
      selectionControls={
        <>
          {selectedControls}
          {deleteConfirmation}
          {dropFeedback}
          {markers}
          <MindmapNodeHandles
            props={{ ...props, draftActive: props.draftActive || dragActive }}
          />
        </>
      }
      workarea={props.workarea}
      workareaFooter={props.workareaFooter}
      workareaLabel={m.controlsLabel()}
    />
  );
}

export function MindmapLabelActions({
  props,
}: {
  props: MindmapLabelActionsProps;
}) {
  const t = useI18n();
  return (
    <Popover opened fitViewport closeOnEscape={false} returnFocus={false}>
      <PopoverTarget>
        {/* This anchor is the native text field's renderer geometry. */}
        <Box
          pos="absolute"
          style={{ ...props.bounds, pointerEvents: "none" }}
        />
      </PopoverTarget>
      <PopoverContent
        aria-label={m.selectedNodeLabel()}
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <Group>
          <Button variant="primary" onClick={props.apply}>
            {t.Apply()}
          </Button>
          <Button onClick={props.cancel}>{t.Cancel()}</Button>
        </Group>
      </PopoverContent>
    </Popover>
  );
}
