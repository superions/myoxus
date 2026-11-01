// SPDX-License-Identifier: AGPL-3.0-or-later

import { useI18n } from "@myoxus/i18n";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  InlineLink,
  IconButton,
  Badge,
  Button,
  Group,
  KanbanBoard,
  MyoxusText,
  Menu,
  MenuItem,
  Popover,
  PopoverTarget,
  PopoverContent,
  Stack,
  Scrollable,
  type KanbanSelection,
} from "@myoxus/ui-facade";
import {
  mermaidKanbanRendererToken,
  mermaidMessages as messages,
  readKanbanConfig,
  type MermaidFamilyReactRendererRegistration,
  type MermaidKanbanReactHostProps,
  type KanbanCommand,
  type MermaidKanbanNode,
} from "@virgultum/block-mermaid";
import { isTouchPadPinchEvent } from "@virgultum/shared/utils";
import { CommentIcon } from "@myoxus/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { renderSafeMarkdownLabel } from "../mermaid-markdown-label";
import { MermaidEmbeddedActions } from "../mermaid-embedded-actions";
import {
  MermaidEditorWorkbench,
  useMermaidSelectionAction,
} from "../mermaid-editor-workbench";
import {
  createKanbanDraft,
  kanbanDraftCommand,
  type KanbanDraft,
} from "./drafts";
import { projectKanbanBoard, kanbanTicketHref } from "./projection";
import { KanbanCardMetadataPopover } from "./card-metadata-popover";
import { KanbanCommentsPopover } from "./comments-popover";
import { KanbanColumnDeleteDialog } from "./column-delete-dialog";
import { KanbanConfigPopover } from "./config-popover";
import { kanbanSelectionExists, nextKanbanSelection } from "./selection";

/** Core only coordinates local interaction and the neutral board. The family owns every source write. */
export function MermaidKanbanRuntime({
  props,
}: {
  props: MermaidKanbanReactHostProps;
}) {
  const t = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState(props.selection);
  const [draft, setDraft] = useState<KanbanDraft>();
  const [editRequest, setEditRequest] = useState<{
    id: string;
    kind: "card" | "column";
    requestId: number;
  }>();
  const [focusRequest, setFocusRequest] = useState<{
    requestId: number;
    selection?: KanbanSelection;
    target?: "board" | "add-column-empty";
  }>();
  const [overlay, setOverlay] = useState<{
    id: string | null;
    kind: "metadata" | "data" | "comments" | "position-comments";
  }>();
  const [options, setOptions] = useState<
    "appearance" | "tickets" | "data" | "more"
  >();
  const [deleting, setDeleting] = useState<string>();
  const [commentsVisible, setCommentsVisible] = useState(true);
  const [notice, setNotice] = useState<string>();
  const basisRef = useRef(props.model.sourceDocument.source);
  const interactionRef = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  const source = props.model.sourceDocument.source;
  const readonly = props.readonly || props.displayOnly || props.model.ambiguous;
  useEffect(() => {
    setSelection(props.selection);
  }, [props.selection]);
  useEffect(() => {
    if (props.replayed) {
      setDraft(undefined);
      setEditRequest(undefined);
      setDeleting(undefined);
      setOptions(undefined);
      setOverlay(undefined);
      setFocusRequest({
        requestId: ++sequence.current,
        selection: props.selection,
      });
    }
  }, [props.replayed, source, props.selection]);
  useEffect(() => {
    const objects = [...props.model.columns, ...props.model.cards];
    if (
      (interactionRef.current &&
        interactionRef.current !== draft?.key &&
        !objects.some((node) => node.id === interactionRef.current)) ||
      (draft &&
        [draft.columnId, draft.afterId].some(
          (id) => id && !objects.some((node) => node.id === id),
        ))
    ) {
      interactionRef.current = undefined;
      setDraft(undefined);
      setEditRequest(undefined);
      setNotice(messages.ganttDiagnosticConflict());
    }
    if (readonly || props.model.ambiguous) {
      setDraft(undefined);
      setDeleting(undefined);
      setEditRequest(undefined);
    }
    if (
      overlay?.id &&
      overlay.kind !== "position-comments" &&
      ![...props.model.columns, ...props.model.cards].some(
        (node) => node.id === overlay.id,
      )
    ) {
      setOverlay(undefined);
      setNotice(messages.ganttDiagnosticConflict());
    }
  }, [readonly, props.model, overlay, draft]);
  useEffect(() => {
    const root = rootRef.current;
    if (!props.embedded || !root) return;
    const wheel = (event: WheelEvent) => {
      if (!isTouchPadPinchEvent(event)) event.stopPropagation();
    };
    root.addEventListener("wheel", wheel, { passive: true });
    return () => root.removeEventListener("wheel", wheel);
  }, [props.embedded]);
  const select = (value: KanbanSelection | undefined) => {
    setSelection(value);
    props.onSelectionChange(value);
  };
  const focus = (value: KanbanSelection | undefined) =>
    setFocusRequest({
      requestId: ++sequence.current,
      ...(value
        ? { selection: value }
        : {
            target: props.model.columns.length ? "board" : "add-column-empty",
          }),
    });
  const apply = (
    command: KanbanCommand | readonly KanbanCommand[],
    basis = source,
  ) => {
    const result = props.onCommand(command, basis);
    interactionRef.current = undefined;
    if (result.changed || result.reason === "no-change") {
      setNotice(undefined);
      if (result.selection) {
        select(result.selection);
        focus(result.selection);
      }
      return true;
    }
    setNotice(
      result.reason === "conflict"
        ? messages.ganttDiagnosticConflict()
        : messages.ganttCommandRejected(),
    );
    return false;
  };
  const cancel = () => {
    setDraft(undefined);
    setEditRequest(undefined);
    setOverlay(undefined);
    setOptions(undefined);
    focus(selection);
  };
  const add = (kind: "card" | "column", columnId?: string) => {
    if (readonly) return;
    const next = createKanbanDraft(
      kind,
      source,
      columnId,
      kind === "column" ? selection?.columnId : undefined,
    );
    setOverlay(undefined);
    setDraft(next);
    setEditRequest({ kind, id: next.key, requestId: ++sequence.current });
  };
  const rename = (id: string, label: string) => {
    if (draft?.key === id) {
      if (apply(kanbanDraftCommand(draft, label), draft.source)) {
        setDraft(undefined);
        setEditRequest(undefined);
      }
      return;
    }
    apply({ type: "rename", id, label }, basisRef.current);
  };
  const remove = (id: string) => {
    if (props.model.columns.some((column) => column.id === id)) {
      setDeleting(id);
      return;
    }
    const next = nextKanbanSelection(props.model, id);
    if (apply({ type: "delete", id })) {
      select(next);
      focus(next);
    }
  };
  useMermaidSelectionAction({
    disabled: readonly,
    label: messages.visualDelete(),
    onSelect: () => {
      const id = selection?.cardId ?? selection?.columnId;
      if (id) remove(id);
    },
    register: props.onSelectionActionChange,
    selectionKey: kanbanSelectionExists(props.model, selection)
      ? (selection?.cardId ?? selection?.columnId)
      : null,
  });
  const open = (
    id: string,
    kind: "metadata" | "data" | "comments" = "metadata",
  ) => {
    select(
      props.model.cards.some((card) => card.id === id)
        ? { cardId: id }
        : { columnId: id },
    );
    setOverlay({ id, kind });
    setOptions(undefined);
  };
  const frame = (node: MermaidKanbanNode, content: ReactNode) => (
    <Popover
      opened={overlay?.id === node.id}
      onChange={(opened) => {
        if (!opened) {
          setOverlay(undefined);
          focus(selection);
        }
      }}
      fitViewport
      returnFocus
      trapFocus
      withArrow
    >
      <PopoverTarget>{content}</PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="kanban-object">
        <Scrollable.Viewport autosize maxHeight="floating">
          {overlay?.id === node.id ? (
            overlay.kind === "comments" ? (
              <KanbanCommentsPopover
                props={props}
                anchorId={node.id}
                onClose={cancel}
              />
            ) : (
              <KanbanCardMetadataPopover
                props={props}
                node={node}
                data={overlay.kind === "data"}
                onClose={cancel}
              />
            )
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const marker = (id: string | null, compact = false) => {
    const count = props.model.comments.filter(
      (comment) => comment.anchorId === id && comment.affinity === "object",
    ).length;
    if (!commentsVisible || (!count && readonly)) return null;
    const label = `${messages.visualComments()}: ${count}`;
    const onClick = () =>
      id ? open(id, "comments") : setOverlay({ id: null, kind: "comments" });
    return count && !compact ? (
      <Button
        variant="plain"
        aria-label={label}
        prefix={<CommentIcon />}
        onClick={onClick}
      >
        {count}
      </Button>
    ) : (
      <IconButton aria-label={label} tooltip={label} onClick={onClick}>
        <CommentIcon />
      </IconButton>
    );
  };
  const positionMarker = (comment: (typeof props.model.comments)[number]) => (
    <Popover
      key={comment.id}
      opened={
        overlay?.id === comment.id && overlay.kind === "position-comments"
      }
      onChange={(opened) => {
        if (!opened) setOverlay(undefined);
      }}
      fitViewport
      returnFocus
      trapFocus
      withArrow
    >
      <PopoverTarget>
        <IconButton
          aria-label={`${messages.visualComments()}: ${comment.text}`}
          tooltip={comment.text}
          onClick={() =>
            setOverlay({ id: comment.id, kind: "position-comments" })
          }
        >
          <CommentIcon />
        </IconButton>
      </PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="kanban-position-comment">
        <Scrollable.Viewport autosize maxHeight="floating">
          {overlay?.id === comment.id ? (
            <KanbanCommentsPopover
              props={props}
              anchorId={null}
              commentId={comment.id}
              onClose={() => setOverlay(undefined)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const followingObject = (offset: number) =>
    [...props.model.columns, ...props.model.cards]
      .flatMap((node) => {
        const record = props.model.sourceDocument.records.find(
          (record) => record.sourceKey === node.id,
        );
        return record ? [{ node, start: record.range.start }] : [];
      })
      .filter((item) => item.start > offset)
      .sort((a, b) => a.start - b.start)[0]?.node.id;
  const boardPosition = (offset: number) =>
    ![...props.model.columns, ...props.model.cards].some((node) => {
      const record = props.model.sourceDocument.records.find(
        (record) => record.sourceKey === node.id,
      );
      return record && record.range.start < offset;
    });
  const positioned = (id?: string) => {
    if (!commentsVisible) return null;
    const comments = props.model.comments.filter(
      (comment) =>
        comment.affinity === "position" &&
        (boardPosition(comment.range.start)
          ? id === "board"
          : followingObject(comment.range.end) === id),
    );
    return comments.length ? <>{comments.map(positionMarker)}</> : null;
  };
  const config = readKanbanConfig(props.model.sourceDocument).effective;
  const columns = projectKanbanBoard(props.model, readonly, draft).map(
    (column) => {
      const node = props.model.columns.find((node) => node.id === column.id);
      return {
        ...column,
        width: Number(config.sectionWidth) || 200,
        actions: node ? (
          <Group wrap="nowrap">
            {marker(node.id, true)}
            {positioned(node.id)}
          </Group>
        ) : undefined,
        frame: node ? (content: ReactNode) => frame(node, content) : undefined,
        cards: column.cards.map((card) => {
          const node = props.model.cards.find((node) => node.id === card.id);
          if (!node) return card;
          const ticket = node.metadata.ticket
            ? String(node.metadata.ticket)
            : "";
          const href = kanbanTicketHref(
            String(config.ticketBaseUrl ?? ""),
            ticket,
          );
          return {
            ...card,
            precedingContent: positioned(node.id),
            frame: (content: ReactNode) => frame(node, content),
            content: (
              <Group>
                {node.icon ? <Badge>{node.icon}</Badge> : null}
                {node.metadata.assigned ? (
                  <Badge>{String(node.metadata.assigned)}</Badge>
                ) : null}
                {node.metadata.priority ? (
                  <Badge>{String(node.metadata.priority)}</Badge>
                ) : null}
                {ticket ? (
                  href ? (
                    <InlineLink
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {ticket}
                    </InlineLink>
                  ) : (
                    <Badge>{ticket}</Badge>
                  )
                ) : null}
                {ticket && config.ticketBaseUrl && !href ? (
                  <MyoxusText tone="danger">
                    {messages.kanbanUnsafeTicket()}
                  </MyoxusText>
                ) : null}
              </Group>
            ),
            actions: marker(node.id),
          };
        }),
      };
    },
  );
  const optionsTrigger = (
    kind: "appearance" | "tickets" | "data",
    label: string,
  ) => (
    <Popover
      key={kind}
      opened={options === kind}
      onChange={(opened) => {
        if (!opened) setOptions(undefined);
      }}
      fitViewport
      returnFocus
      trapFocus
    >
      <PopoverTarget>
        <Button
          variant="plain"
          onClick={() => {
            if (kind === "data" && (selection?.cardId || selection?.columnId)) {
              open((selection.cardId ?? selection.columnId)!, "data");
              return;
            }
            setOptions(options === kind ? undefined : kind);
            setOverlay(undefined);
          }}
        >
          {label}
        </Button>
      </PopoverTarget>
      <PopoverContent data-myoxus-editor-keyboard-owner="kanban-options">
        <Scrollable.Viewport autosize maxHeight="floating">
          {options === kind ? (
            <KanbanConfigPopover
              props={props}
              kind={kind}
              onClose={() => setOptions(undefined)}
            />
          ) : null}
        </Scrollable.Viewport>
      </PopoverContent>
    </Popover>
  );
  const toolbar = props.displayOnly ? null : (
    <Group>
      {!readonly && !props.model.ambiguous ? (
        <Button onClick={() => add("column")}>
          {messages.kanbanAddColumn()}
        </Button>
      ) : null}
      <Button
        variant="plain"
        aria-pressed={commentsVisible}
        onClick={() => setCommentsVisible(!commentsVisible)}
      >
        {messages.visualComments()}
      </Button>
      {optionsTrigger("appearance", messages.visualAppearance())}
      {optionsTrigger("tickets", messages.kanbanTickets())}
      {optionsTrigger("data", messages.treemapData())}
      <Menu
        items={
          <>
            {props.onExportMmd ? (
              <MenuItem onSelect={props.onExportMmd}>
                {messages.mmdExport()}
              </MenuItem>
            ) : null}
            {!readonly && (selection?.cardId || selection?.columnId) ? (
              <MenuItem
                onSelect={() => {
                  basisRef.current = source;
                  setEditRequest({
                    kind: selection.cardId ? "card" : "column",
                    id: (selection.cardId ?? selection.columnId)!,
                    requestId: ++sequence.current,
                  });
                }}
              >
                {messages.selectedNodeLabel()}
              </MenuItem>
            ) : null}
          </>
        }
        title={messages.visualMoreActions()}
      >
        <Button variant="plain">{messages.visualMoreActions()}</Button>
      </Menu>
    </Group>
  );
  return (
    <div
      ref={rootRef}
      data-myoxus-editor-keyboard-owner="kanban"
      onKeyDown={(event) => {
        if (event.key === "Escape" && (draft || overlay || options)) {
          event.preventDefault();
          event.stopPropagation();
          props.onConsumeEscape(event.nativeEvent);
          cancel();
        }
      }}
    >
      <MermaidEditorWorkbench
        actionTarget={
          props.embedded ? props.headerActionTarget : props.actionTarget
        }
        pageViewport={props.embedded ? undefined : props.pageViewport}
        isolateEvents={!props.embedded}
        workareaLabel={messages.visualEditorLabel()}
        toolbar={props.embedded ? null : toolbar}
      >
        <Stack>
          {props.embedded && toolbar ? (
            <MermaidEmbeddedActions
              actions={toolbar}
              label={messages.visualEditorLabel()}
              placement="inline"
            />
          ) : null}
          {notice ? <Alert>{notice}</Alert> : null}
          {props.model.diagnostics.map((error) => (
            <Alert key={`${error.anchorId}:${error.code}`}>
              {messages.kanbanDiagnostic(
                error.code,
                error.range.start,
                error.range.end,
                error.range.line,
              )}
            </Alert>
          ))}
          {props.model.ambiguous ? (
            <Alert>
              {props.model.staleProjection
                ? messages.kanbanLastValid()
                : messages.ganttAmbiguousSource()}
              {!props.embedded ? (
                <Button variant="plain" onClick={props.onOpenSource}>
                  {messages.modeSource()}
                </Button>
              ) : null}
            </Alert>
          ) : null}
          <Group>
            <Popover
              opened={overlay?.id === null}
              onChange={(opened) => {
                if (!opened) setOverlay(undefined);
              }}
              fitViewport
              returnFocus
              trapFocus
            >
              <PopoverTarget>
                <Group>{marker(null)}</Group>
              </PopoverTarget>
              <PopoverContent>
                <Scrollable.Viewport autosize maxHeight="floating">
                  {overlay?.id === null ? (
                    <KanbanCommentsPopover
                      props={props}
                      anchorId={null}
                      onClose={() => setOverlay(undefined)}
                    />
                  ) : null}
                </Scrollable.Viewport>
              </PopoverContent>
            </Popover>
            {positioned("board")}
          </Group>
          <KanbanBoard
            scrollOwner={props.embedded ? "self" : "parent"}
            aria-label={messages.visualEditorLabel()}
            data-testid="mermaid-kanban-board"
            columns={columns}
            selection={selection}
            readonly={readonly}
            editRequest={editRequest}
            focusRequest={focusRequest}
            addColumn={{ enabled: !props.model.ambiguous && !columns.length }}
            renderLabel={(label) =>
              renderSafeMarkdownLabel(label, Infinity, "dom")
            }
            onAddColumn={() => add("column")}
            onAddCard={(id) => add("card", id)}
            onSelectCard={(id) => select({ cardId: id })}
            onSelectColumn={(id) => select({ columnId: id })}
            onOpenCard={(id) => open(id)}
            onOpenColumn={(id) => open(id)}
            onRenameCard={rename}
            onRenameColumn={rename}
            onInteractionStart={(_kind, id) => {
              interactionRef.current = id;
              basisRef.current = source;
            }}
            onEditEnd={(_kind, id, outcome) => {
              interactionRef.current = undefined;
              if (outcome === "cancel" && draft?.key === id) {
                setDraft(undefined);
                focus(selection);
              }
            }}
            onMoveCard={(move) => {
              return apply(
                {
                  type: "move-card",
                  id: move.cardId,
                  columnId: move.toColumnId,
                  targetId: move.targetCardId,
                  edge: move.edge,
                },
                basisRef.current,
              );
            }}
            onMoveColumn={(move) => {
              return apply(
                {
                  type: "move-column",
                  id: move.columnId,
                  targetId: move.targetColumnId,
                  edge: move.edge,
                },
                basisRef.current,
              );
            }}
            onDeleteCard={remove}
            onDeleteColumn={remove}
            labels={{
              actions: t["com.myoxus.actions"](),
              addCard: (label) => `${messages.kanbanAddCard()}: ${label}`,
              addColumn: messages.kanbanAddColumn(),
              cardCount: (count) => String(count),
              deleteCard: (label) => `${messages.visualDelete()}: ${label}`,
              deleteColumn: (label) => `${messages.visualDelete()}: ${label}`,
              dragCard: (label) =>
                `${messages.visualMoveKanbanCard()}: ${label}`,
              dragColumn: (label) =>
                `${messages.visualMoveKanbanColumn()}: ${label}`,
              emptyColumn: messages.kanbanEmptyColumn(),
              openCard: (label) =>
                `${t["com.myoxus.workspace-pages.action.open"]()}: ${label}`,
              movedCard: (label, from, to) =>
                `${messages.visualMovedKanban()}: ${label}, ${from}, ${to}`,
              movedColumn: (label, target) =>
                `${messages.visualMovedKanban()}: ${label}, ${target}`,
            }}
          />
          {positioned()}
        </Stack>
      </MermaidEditorWorkbench>
      {deleting ? (
        <KanbanColumnDeleteDialog
          key={deleting}
          props={props}
          id={deleting}
          onClose={() => setDeleting(undefined)}
          onDeleted={() => {
            const next = nextKanbanSelection(props.model, deleting);
            select(next);
            focus(next);
          }}
        />
      ) : null}
    </div>
  );
}
export function createMermaidKanbanRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidKanbanReactHostProps> {
  return {
    token: mermaidKanbanRendererToken,
    render: (props) => reactToLit(<MermaidKanbanRuntime props={props} />, true),
  };
}
