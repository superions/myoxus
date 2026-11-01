// SPDX-License-Identifier: AGPL-3.0-or-later

import { CommentIcon, TableIcon, SettingsIcon } from "@myoxus/icons";
import type { ReactToLit } from "@myoxus/lit-react";
import {
  Alert,
  Button,
  Group,
  IconButton,
  Modal,
  MyoxusText,
  MyoxusTextInput,
  Popover,
  PopoverContent,
  PopoverTarget,
  Scrollable,
  Select,
  Stack,
  type DataSankeyConnectionDraft,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  mermaidSankeyRendererToken,
  sankeyNodeImpact,
  type SankeyCommand,
  type SankeySelection,
  type SankeyConfig,
  type SankeyModel,
  type MermaidSankeyReactHostProps,
  type MermaidFamilyReactRendererRegistration,
} from "@virgultum/block-mermaid";
import { useEffect, useState } from "react";
import { ChartEditorSurface, stopEditorEvent } from "../common";
import { SankeyChartSurface } from "./chart-surface";
import { SankeyDataEditor } from "./data-editor";
import { SankeyNodePopover } from "./node-popover";
import { SankeyLinkPopover } from "./link-popover";
import { SankeyConnectOverlay } from "./connect-overlay";
import { SankeyAppearancePopover } from "./appearance-popover";
import { SankeyComments } from "./comments";

type SankeyConnection =
  | { readonly kind: "add"; readonly sourceId: string }
  | {
      readonly kind: "reconnect";
      readonly field: "source" | "target";
      readonly linkId: string;
      readonly sourceId: string;
    };

export function MermaidSankeyRuntime({
  props,
}: {
  readonly props: MermaidSankeyReactHostProps;
}) {
  const [selection, setSelection] = useState(props.selection);
  const [editing, setEditing] = useState<SankeySelection>(null);
  const [editEndpoints, setEditEndpoints] = useState(false);
  const [deleting, setDeleting] = useState<SankeySelection>(null);
  const [connection, setConnection] = useState<SankeyConnection>();
  const [appearancePreview, setAppearancePreview] = useState<SankeyConfig>();
  const [modelPreview, setModelPreview] = useState<SankeyModel>();
  const [adding, setAdding] = useState<{
    readonly source: string;
    readonly target: string;
  }>();
  const [dataOpen, setDataOpen] = useState(props.initialDataOpen);
  const [popover, setPopover] = useState<"add" | "comments" | "appearance">();
  const [notice, setNotice] = useState<string>();
  const [newEndpoint, setNewEndpoint] = useState("");
  const [focusRequestKey, setFocusRequestKey] = useState(0);
  const source = props.model.sourceDocument.source;
  useEffect(() => {
    setEditing(null);
    setEditEndpoints(false);
    setDeleting(null);
    setConnection(undefined);
    setAppearancePreview(undefined);
    setModelPreview(undefined);
    setAdding(undefined);
    setPopover(undefined);
    setNewEndpoint("");
    setSelection(props.selection);
  }, [source, props.readonly]);
  const closeEditing = () => {
    setEditing(null);
    setFocusRequestKey((key) => key + 1);
  };
  const apply = (command: SankeyCommand | readonly SankeyCommand[]) => {
    const result = props.onCommand(command);
    if (!result.changed) {
      if (result.diagnosis !== "no-change")
        setNotice(
          result.diagnosis === "conflict"
            ? messages.chartSourceChanged()
            : messages.pieInvalid(),
        );
      return false;
    }
    setNotice(undefined);
    setSelection(result.selection);
    setFocusRequestKey((key) => key + 1);
    setEditing(null);
    setEditEndpoints(false);
    setDeleting(null);
    setConnection(undefined);
    setAppearancePreview(undefined);
    setModelPreview(undefined);
    setAdding(undefined);
    setPopover(undefined);
    setNewEndpoint("");
    return true;
  };
  const select = (next: SankeySelection) => {
    setSelection(next);
    props.onSelectionChange(next);
  };
  const nodeLabel = (id: string) =>
    props.model.nodes.find((node) => node.id === id)?.label;
  const validConnectionTargets = (draft: SankeyConnection) =>
    props.model.nodes.flatMap((node) => {
      const label = nodeLabel(node.id);
      if (!label) return [];
      const command: SankeyCommand =
        draft.kind === "add"
          ? {
              type: "link.add",
              source: nodeLabel(draft.sourceId) ?? "",
              target: label,
              value: 1,
            }
          : {
              type: "link.endpoint",
              id: draft.linkId,
              field: draft.field,
              value: label,
            };
      return props.onPreviewCommand(command).changed ? [node.id] : [];
    });
  const connectionDraft: DataSankeyConnectionDraft | undefined = connection
    ? {
        field: connection.kind === "reconnect" ? connection.field : undefined,
        linkId: connection.kind === "reconnect" ? connection.linkId : undefined,
        sourceId: connection.sourceId,
        validTargetIds: validConnectionTargets(connection),
      }
    : undefined;
  const startReconnect = (linkId: string, field: "source" | "target") => {
    const link = props.model.links.find((candidate) => candidate.id === linkId);
    const sourceId = field === "source" ? link?.target : link?.source;
    if (!sourceId) return;
    setNewEndpoint("");
    setConnection({ kind: "reconnect", linkId, field, sourceId });
  };
  const commandForConnectionLabel = (target: string): SankeyCommand | null => {
    if (!connection) return null;
    if (connection.kind === "reconnect")
      return {
        type: "link.endpoint",
        id: connection.linkId,
        field: connection.field,
        value: target,
      };
    const source = nodeLabel(connection.sourceId);
    return source ? { type: "link.add", source, target, value: 1 } : null;
  };
  const commitConnectionLabel = (target: string) => {
    if (!connection) return;
    if (connection.kind === "reconnect") {
      const command = commandForConnectionLabel(target);
      if (command) apply(command);
      return;
    }
    const source = nodeLabel(connection.sourceId);
    if (!source) return;
    setConnection(undefined);
    setNewEndpoint("");
    setAdding({ source, target });
  };
  const commitConnection = (targetId: string) => {
    if (!connection) return;
    const target = nodeLabel(targetId);
    if (!target) return;
    commitConnectionLabel(target);
  };
  const deleteCommand = (
    target: NonNullable<SankeySelection>,
    confirmed = false,
  ): SankeyCommand =>
    target.kind === "node"
      ? { type: "node.delete", id: target.id, confirmed }
      : target.kind === "link"
        ? { type: "link.delete", id: target.id, confirmed }
        : { type: "comment.delete", id: target.id };
  const requestDeleteFor = (target: NonNullable<SankeySelection>) => {
    if (props.readonly) return;
    const command = deleteCommand(target);
    const result = props.onPreviewCommand(command);
    if (result.diagnosis === "confirmation-required") {
      setEditing(null);
      setDeleting(target);
    } else apply(command);
  };
  const requestDelete = () => {
    if (selection) requestDeleteFor(selection);
  };
  const toolbar = props.readonly ? null : (
    <Group>
      {props.model.links.length ? (
        <SankeyConnectOverlay
          props={props}
          opened={popover === "add"}
          onOpenedChange={(opened) => {
            if (!opened) setModelPreview(undefined);
            setPopover(opened ? "add" : undefined);
          }}
          onApply={apply}
          onPreviewModel={setModelPreview}
          onStartSelected={
            selection?.kind === "node"
              ? () => {
                  setNewEndpoint("");
                  setConnection({ kind: "add", sourceId: selection.id });
                }
              : undefined
          }
        />
      ) : null}
      <IconButton
        icon={<TableIcon />}
        aria-label={messages.pieData()}
        tooltip={messages.pieData()}
        aria-pressed={dataOpen}
        onClick={() => {
          setDataOpen(!dataOpen);
          props.onDataOpenChange(!dataOpen);
        }}
      />
      {(["comments", "appearance"] as const).map((kind) => (
        <Popover
          key={kind}
          opened={popover === kind}
          onChange={(opened) => {
            if (!opened && kind === "appearance")
              setAppearancePreview(undefined);
            setPopover(opened ? kind : undefined);
          }}
          fitViewport
        >
          <PopoverTarget>
            <IconButton
              icon={kind === "comments" ? <CommentIcon /> : <SettingsIcon />}
              aria-label={
                kind === "comments"
                  ? messages.visualComments()
                  : messages.visualAppearance()
              }
              tooltip={
                kind === "comments"
                  ? messages.visualComments()
                  : messages.visualAppearance()
              }
              onClick={() => setPopover(popover === kind ? undefined : kind)}
            />
          </PopoverTarget>
          <PopoverContent>
            <Scrollable.Viewport autosize maxHeight="floating">
              {kind === "comments" ? (
                <SankeyComments
                  props={props}
                  linkId={
                    selection?.kind === "link"
                      ? selection.id
                      : selection?.kind === "comment"
                        ? props.model.comments.find(
                            (comment) => comment.id === selection.id,
                          )?.linkId
                        : undefined
                  }
                  onApply={apply}
                  onSelect={select}
                />
              ) : (
                <SankeyAppearancePopover
                  props={props}
                  onApply={apply}
                  onCancel={() => setPopover(undefined)}
                  onPreviewConfig={setAppearancePreview}
                />
              )}
            </Scrollable.Viewport>
          </PopoverContent>
        </Popover>
      ))}
    </Group>
  );
  const impact =
    deleting?.kind === "node"
      ? sankeyNodeImpact(props.model, deleting.id)
      : null;
  const deletingNode =
    deleting?.kind === "node"
      ? props.model.nodes.find((node) => node.id === deleting.id)
      : undefined;
  return (
    <div
      data-testid="mermaid-sankey-view"
      onPointerDown={props.embedded ? undefined : stopEditorEvent}
      onKeyDown={(event) => {
        const target = event.target;
        const editingField =
          target instanceof HTMLInputElement ||
          target instanceof HTMLTextAreaElement ||
          (target instanceof HTMLElement && target.isContentEditable);
        if (
          !editingField &&
          (event.key === "Delete" || event.key === "Backspace")
        ) {
          event.preventDefault();
          requestDelete();
        }
        if (!props.embedded) stopEditorEvent(event);
      }}
    >
      <ChartEditorSurface
        actionTarget={props.actionTarget}
        embedded={props.embedded}
        pageViewport={props.pageViewport}
        context={null}
        contextOpened={false}
        contextTitle={messages.pieData()}
        onCloseContext={() => setEditing(null)}
        selectedId={selection?.id}
        toolbar={toolbar}
        workareaLabel={messages.visualEditorLabel()}
        selectionAction={{
          disabled: props.readonly || !selection,
          label: messages.visualDelete(),
          onSelect: requestDelete,
          register: props.onSelectionActionChange,
          selectionKey: selection
            ? `${selection.kind}:${selection.id}`
            : undefined,
        }}
      >
        {notice ? <Alert role="status">{notice}</Alert> : null}
        <SankeyChartSurface
          props={props}
          model={modelPreview}
          config={appearancePreview}
          commentsVisible={popover === "comments"}
          focusRequestKey={focusRequestKey}
          selection={selection}
          onSelect={select}
          onEdit={(next) => {
            setEditEndpoints(false);
            setEditing(next);
          }}
          onRepair={(next) => {
            setEditEndpoints(true);
            setEditing(next);
          }}
          onOpenComment={(commentId) => {
            select({ kind: "comment", id: commentId });
            setPopover("comments");
          }}
          onOpenDiagramComment={(commentId) => {
            select({ kind: "comment", id: commentId });
            setPopover("comments");
          }}
          onOpenSource={props.onOpenSource}
          onAdd={() => setPopover("add")}
          connectionDraft={connectionDraft}
          onConnectStart={(sourceId) => {
            setNewEndpoint("");
            setConnection({ kind: "add", sourceId });
          }}
          onReconnectStart={startReconnect}
          onConnectionCommit={commitConnection}
          onConnectionCancel={() => setConnection(undefined)}
        />
        {connection ? (
          <Stack
            onKeyDown={(event) => {
              if (event.key === "Escape")
                props.onConsumeEscape(event.nativeEvent);
              event.stopPropagation();
            }}
          >
            <Group>
              <Select
                searchable
                label={messages.visualConnecting()}
                placeholder={messages.visualConnectingHint()}
                value={null}
                data={validConnectionTargets(connection).flatMap((id) => {
                  const label = nodeLabel(id);
                  return label ? [{ value: id, label }] : [];
                })}
                onChange={commitConnection}
              />
              <Button variant="plain" onClick={() => setConnection(undefined)}>
                {messages.cancel()}
              </Button>
            </Group>
            <Group align="flex-end">
              <MyoxusTextInput
                label={
                  connection.kind === "reconnect" &&
                  connection.field === "source"
                    ? messages.chartSource()
                    : messages.chartTarget()
                }
                value={newEndpoint}
                onChange={setNewEndpoint}
              />
              <Button
                disabled={
                  !newEndpoint.trim() ||
                  !props.onPreviewCommand(
                    commandForConnectionLabel(newEndpoint) ?? [],
                  ).changed
                }
                onClick={() => commitConnectionLabel(newEndpoint)}
              >
                {messages.architectureApply()}
              </Button>
            </Group>
          </Stack>
        ) : null}
        {dataOpen && !props.readonly ? (
          <SankeyDataEditor
            props={props}
            onApply={apply}
            onDelete={(id) => requestDeleteFor({ kind: "link", id })}
            onEdit={(next) => {
              select(next);
              setEditEndpoints(true);
              setEditing(next);
            }}
          />
        ) : null}
        <Modal
          open={Boolean(adding)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => {
            if (!opened) setAdding(undefined);
          }}
          title={messages.chartAddLink()}
        >
          {adding ? (
            <SankeyLinkPopover
              key={`${adding.source}:${adding.target}`}
              props={props}
              initial={{ ...adding, value: 1 }}
              onApply={apply}
              onCancel={() => {
                setModelPreview(undefined);
                setAdding(undefined);
              }}
              onPreviewModel={setModelPreview}
            />
          ) : null}
        </Modal>
        <Modal
          open={Boolean(editing)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => {
            if (!opened) closeEditing();
          }}
          title={
            editing?.kind === "node"
              ? messages.selectedNodeLabel()
              : messages.selectedSankeyValue()
          }
        >
          {editing?.kind === "node" ? (
            <SankeyNodePopover
              key={`${source}:${editing.id}`}
              props={props}
              id={editing.id}
              onApply={apply}
              onCancel={() => {
                setModelPreview(undefined);
                closeEditing();
              }}
              onDelete={() => requestDeleteFor(editing)}
              onPreviewModel={setModelPreview}
            />
          ) : editing?.kind === "link" ? (
            <SankeyLinkPopover
              key={`${source}:${editing.id}`}
              props={props}
              id={editing.id}
              endpointsEditable={editEndpoints}
              onApply={apply}
              onCancel={() => {
                setModelPreview(undefined);
                closeEditing();
              }}
              onDelete={() => requestDeleteFor(editing)}
              onPreviewModel={setModelPreview}
            />
          ) : null}
        </Modal>
        <Modal
          open={Boolean(deleting)}
          onEscape={props.onConsumeEscape}
          onOpenChange={(opened) => {
            if (!opened) setDeleting(null);
          }}
          title={messages.visualDelete()}
        >
          <Stack
            onKeyDown={(event) => {
              if (event.key === "Escape")
                props.onConsumeEscape(event.nativeEvent);
              event.stopPropagation();
            }}
          >
            <MyoxusText>{messages.selectionDeleteImpact()}</MyoxusText>
            {deleting?.kind === "node" && impact ? (
              <>
                <MyoxusText>{deletingNode?.label}</MyoxusText>
                <MyoxusText>
                  {messages.sankeyDeleteImpact(
                    impact.links.length,
                    new Intl.NumberFormat().format(impact.sum),
                    impact.invalidValues,
                    impact.comments.length,
                  )}
                </MyoxusText>
                {deletingNode &&
                props.model.config.nodeColors[deletingNode.label] ? (
                  <MyoxusText>
                    {messages.sankeyNodeColor()}:{" "}
                    {props.model.config.nodeColors[deletingNode.label]}
                  </MyoxusText>
                ) : null}
              </>
            ) : null}
            {impact?.links.map((link) => (
              <MyoxusText key={link.id}>
                {
                  props.model.nodes.find((node) => node.id === link.source)
                    ?.label
                }{" "}
                →{" "}
                {
                  props.model.nodes.find((node) => node.id === link.target)
                    ?.label
                }
                : {link.value}
              </MyoxusText>
            ))}
            {props.model.comments
              .filter((comment) =>
                impact
                  ? impact.comments.includes(comment)
                  : comment.linkId === deleting?.id,
              )
              .map((comment) => (
                <MyoxusText key={comment.id}>{comment.text}</MyoxusText>
              ))}
            <Group justify="flex-end">
              <Button variant="plain" onClick={() => setDeleting(null)}>
                {messages.cancel()}
              </Button>
              <Button
                onClick={() => deleting && apply(deleteCommand(deleting, true))}
              >
                {messages.visualDelete()}
              </Button>
            </Group>
          </Stack>
        </Modal>
      </ChartEditorSurface>
    </div>
  );
}

export function createMermaidSankeyRendererRegistration(
  reactToLit: ReactToLit,
): MermaidFamilyReactRendererRegistration<MermaidSankeyReactHostProps> {
  return {
    token: mermaidSankeyRendererToken,
    render: (props) => reactToLit(<MermaidSankeyRuntime props={props} />, true),
  };
}
