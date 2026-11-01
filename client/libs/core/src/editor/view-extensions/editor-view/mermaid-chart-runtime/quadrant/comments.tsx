// SPDX-License-Identifier: AGPL-3.0-or-later

import { DataChartCommentMarker } from "@myoxus/ui-facade";
import type {
  MermaidQuadrantCommentAnchor,
  MermaidQuadrantCommand,
  MermaidQuadrantReactHostProps,
} from "@virgultum/block-mermaid";

export function MermaidQuadrantComments({
  anchor,
  onCommand,
  onDraftInvalidated,
  props,
}: {
  readonly anchor: MermaidQuadrantCommentAnchor;
  readonly onCommand: (command: MermaidQuadrantCommand) => boolean;
  readonly onDraftInvalidated: () => void;
  readonly props: MermaidQuadrantReactHostProps;
}) {
  const items = props.comments.filter(
    (comment) =>
      comment.anchor.kind === anchor.kind &&
      (anchor.kind === "diagram" ||
        ("id" in comment.anchor && comment.anchor.id === anchor.id)),
  );
  return (
    <DataChartCommentMarker
      addLabel={props.labels.addComment}
      applyLabel={props.labels.apply}
      deleteLabel={props.labels.deleteComment}
      invalidLabel={props.labels.invalid}
      items={items}
      label={props.labels.comments}
      onAdd={(text) =>
        onCommand({ anchor, position: "after", text, type: "comment.add" })
      }
      onDelete={(commentId) => onCommand({ commentId, type: "comment.delete" })}
      onDraftInvalidated={onDraftInvalidated}
      onUpdate={(commentId, text) =>
        onCommand({ commentId, text, type: "comment.update" })
      }
      revision={props.model.sourceHash}
    />
  );
}
