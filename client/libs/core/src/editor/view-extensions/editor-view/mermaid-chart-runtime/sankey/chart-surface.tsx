// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  DataSankeyChart,
  Stack,
  type DataSankeyConnectionDraft,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidSankeyReactHostProps,
  type SankeyConfig,
  type SankeyModel,
  type SankeySelection,
} from "@virgultum/block-mermaid";

export function SankeyChartSurface({
  connectionDraft,
  commentsVisible,
  focusRequestKey,
  props,
  model = props.model,
  config = model.config,
  onAdd,
  onConnectStart,
  onConnectionCancel,
  onConnectionCommit,
  onEdit,
  onOpenComment,
  onOpenDiagramComment,
  onOpenSource,
  onRepair,
  onReconnectStart,
  onSelect,
  selection,
}: {
  readonly connectionDraft?: DataSankeyConnectionDraft;
  readonly commentsVisible: boolean;
  readonly focusRequestKey: number;
  readonly config?: SankeyConfig;
  readonly model?: SankeyModel;
  readonly onAdd: () => void;
  readonly onConnectStart: (nodeId: string) => void;
  readonly onConnectionCancel: () => void;
  readonly onConnectionCommit: (nodeId: string) => void;
  readonly onEdit: (selection: Exclude<SankeySelection, null>) => void;
  readonly onOpenComment: (commentId: string, linkId: string) => void;
  readonly onOpenDiagramComment: (commentId: string) => void;
  readonly onOpenSource: () => void;
  readonly onRepair: (selection: Exclude<SankeySelection, null>) => void;
  readonly onReconnectStart: (
    linkId: string,
    field: "source" | "target",
  ) => void;
  readonly onSelect: (selection: SankeySelection) => void;
  readonly props: MermaidSankeyReactHostProps;
  readonly selection: SankeySelection;
}) {
  const chartSelection =
    selection &&
    (selection.kind === "comment" ||
      selection.kind === "link" ||
      selection.kind === "node")
      ? { id: selection.id, kind: selection.kind }
      : null;
  return (
    <Stack>
      <DataSankeyChart
        ariaLabel={model.title || messages.visualEditorLabel()}
        compact={props.embedded}
        connectionDraft={connectionDraft}
        emptyAction={
          props.readonly || model.links.length ? null : (
            <Button onClick={onAdd}>{messages.chartAddLink()}</Button>
          )
        }
        emptyLabel={messages.previewEmpty()}
        focusRequestKey={focusRequestKey}
        geometry={{
          alignment: config.nodeAlignment,
          height: config.height,
          labelStyle: config.labelStyle,
          nodePadding: config.nodePadding,
          nodeWidth: config.nodeWidth,
          showValues: config.showValues,
          useMaxWidth: config.useMaxWidth,
          width: config.width,
        }}
        interactive={!props.displayOnly}
        labels={{
          comments: (count) => `${messages.visualComments()} (${count})`,
          connectFromNode: messages.visualConnectorHandle(),
          reconnectSource: messages.visualReconnectSource(),
          reconnectTarget: messages.visualReconnectTarget(),
        }}
        linkColor={config.linkColor}
        linkComments={
          commentsVisible
            ? model.comments.flatMap((comment) =>
                comment.linkId
                  ? [{ id: comment.id, linkId: comment.linkId }]
                  : [],
              )
            : []
        }
        links={model.links.flatMap((link) =>
          link.renderable && link.source && link.target
            ? [
                {
                  id: link.id,
                  sourceId: link.source,
                  targetId: link.target,
                  value: link.value,
                },
              ]
            : [],
        )}
        nodes={model.nodes.map((node) => ({
          ...node,
          color: config.nodeColors[node.label],
        }))}
        onConnectStart={props.readonly ? undefined : onConnectStart}
        onConnectionCancel={props.readonly ? undefined : onConnectionCancel}
        onConnectionCommit={props.readonly ? undefined : onConnectionCommit}
        onEdit={props.readonly ? undefined : onEdit}
        onReconnectStart={props.readonly ? undefined : onReconnectStart}
        onOpenComment={props.displayOnly ? undefined : onOpenComment}
        onSelect={props.displayOnly ? undefined : onSelect}
        readonly={props.readonly}
        selected={chartSelection}
        valuePrefix={config.prefix}
        valueSuffix={config.suffix}
      />
      {commentsVisible
        ? model.comments
            .filter((comment) => !comment.linkId)
            .map((comment) => (
              <Button
                key={comment.id}
                variant="plain"
                onClick={() => onOpenDiagramComment(comment.id)}
              >
                {messages.visualComments()}: {comment.text}
              </Button>
            ))
        : null}
      {model.diagnostics.length ? (
        <Alert role="status">
          <Stack>
            {model.diagnostics.map((diagnostic) => {
              const reason =
                diagnostic.field === "source"
                  ? messages.chartSource()
                  : diagnostic.field === "target"
                    ? messages.chartTarget()
                    : diagnostic.field === "value"
                      ? messages.selectedSankeyValue()
                      : messages.errorTitle();
              const link = model.links.find(
                (candidate) => candidate.id === diagnostic.recordId,
              );
              return (
                <Button
                  key={`${diagnostic.recordId}:${diagnostic.code}:${diagnostic.field ?? "record"}`}
                  variant="plain"
                  onClick={() =>
                    link
                      ? onRepair({ kind: "link", id: link.id })
                      : onOpenSource()
                  }
                >
                  {messages.sankeyInvalidRecord(diagnostic.line, reason)}
                </Button>
              );
            })}
          </Stack>
        </Alert>
      ) : null}
    </Stack>
  );
}
