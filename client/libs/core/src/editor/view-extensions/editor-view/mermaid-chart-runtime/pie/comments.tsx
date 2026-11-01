// SPDX-License-Identifier: AGPL-3.0-or-later

import { DataChartCommentMarker } from "@myoxus/ui-facade";
import type { MermaidPieReactHostProps } from "@virgultum/block-mermaid";

export function MermaidPieComments({
  comments,
  onDraftInvalidated,
  props,
  sliceId,
}: {
  readonly comments: MermaidPieReactHostProps["diagramComments"];
  readonly onDraftInvalidated?: () => void;
  readonly props: MermaidPieReactHostProps;
  readonly sliceId?: string;
}) {
  return (
    <DataChartCommentMarker
      addLabel={props.labels.addComment}
      applyLabel={props.labels.apply}
      deleteLabel={props.labels.deleteComment}
      invalidLabel={props.labels.invalid}
      items={comments}
      label={props.labels.comments}
      onAdd={(text) =>
        Boolean(
          props.onCommand({
            anchor: sliceId ? { kind: "slice", sliceId } : { kind: "diagram" },
            position: "after",
            text,
            type: "comment.add",
          }),
        )
      }
      onDelete={(commentId) =>
        Boolean(props.onCommand({ commentId, type: "comment.delete" }))
      }
      onUpdate={(commentId, text) =>
        Boolean(
          props.onCommand({
            commentId,
            text,
            type: "comment.update",
          }),
        )
      }
      onDraftInvalidated={onDraftInvalidated}
      revision={props.model.sourceHash}
    />
  );
}
