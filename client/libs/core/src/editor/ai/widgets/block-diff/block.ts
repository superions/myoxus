import { cssVar } from "@myoxus/theme";
import track from "@myoxus/track";
import { useHover } from "@myoxus/ui-facade";
import { type EditorHost, WidgetViewExtension } from "@virgultum/editor/std";
import { createElement, type ReactNode } from "react";

import { StoredAnswerText } from "../../components/ai-message-content/stored-answer-text";
import type { BlockDiffProvider } from "../../services/block-diff";
import { DiffWidget } from "./diff-widget";
import { DiffOptions } from "./view";

export const MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK =
  "myoxus-block-diff-widget-for-block";
type Change = Parameters<BlockDiffProvider["accept"]>[0];

function BlockDiffRow({
  diffId,
  changeType,
  content,
  host,
  onAccept,
  onReject,
}: {
  diffId: string;
  changeType: Change["type"];
  content: string | null;
  host: EditorHost;
  onAccept: () => void;
  onReject: () => void;
}) {
  const { hovered, ref } = useHover<HTMLDivElement>();
  const isDelete = changeType === "delete";

  return createElement(
    "div",
    {
      ref,
      className: `ai-block-diff ${changeType}`,
      "data-diff-id": diffId,
      "data-myoxus-ui-role": "ai-block-diff-row",
      style: isDelete
        ? {
            position: "absolute",
            top: "calc(var(--mantine-spacing-sm) * -1)",
            left: "var(--mantine-spacing-xs)",
            width: "100%",
            height: "100%",
            margin: 0,
            pointerEvents: "auto",
            borderRadius: "var(--mantine-radius-sm)",
          }
        : {
            position: "relative",
            marginTop: "var(--mantine-spacing-sm)",
            marginBottom: "var(--mantine-spacing-sm)",
            pointerEvents: "auto",
            backgroundColor: cssVar("backgroundProcessingColor"),
            paddingBlock: "var(--mantine-spacing-sm)",
            borderRadius: "var(--mantine-radius-sm)",
          },
    },
    content !== null &&
      createElement(StoredAnswerText, {
        host,
        text: content,
      }),
    createElement(
      "div",
      {
        className: "diff-options",
        style: {
          position: "absolute",
          top: 0,
          right:
            "calc((var(--mantine-spacing-lg) + var(--mantine-spacing-xs)) * -1)",
          pointerEvents: "auto",
          opacity: hovered ? 1 : 0,
        },
      },
      createElement(DiffOptions, {
        accept: onAccept,
        reject: onReject,
      }),
    ),
  );
}

export class MyoxusBlockDiffWidgetForBlock extends DiffWidget {
  private decorated?: HTMLElement;

  protected renderDiff() {
    const service = this.diffService;
    const id = this.model.id;
    const block = this.block;
    this.decorated?.classList.remove("ai-block-diff-deleted");
    this.decorated = undefined;
    if (
      !block ||
      !service.hasDiff() ||
      service.getBlockIndexById(this.store, id) < 0
    )
      return null;
    const { deletes, updates, inserts } = service.getDiff();
    const rows: ReactNode[] = [];
    const row = (key: string, change: Change) => {
      const content = change.type === "delete" ? null : change.payload.content;
      rows.push(
        createElement(BlockDiffRow, {
          key,
          diffId: key,
          changeType: change.type,
          content,
          host: this.host,
          onAccept: () => {
            track.applyModel.widget.block.accept();
            void service.accept(change, this.store);
          },
          onReject: () => {
            track.applyModel.widget.block.reject();
            service.reject(change);
          },
        }),
      );
    };
    if (deletes.includes(id) && !service.isRejected("delete", id)) {
      block.classList.add("ai-block-diff-deleted");
      this.decorated = block;
      row("delete-" + id, { type: "delete", payload: { id } });
    }
    if (updates[id] && !service.isRejected("update", id)) {
      row("update-" + id, {
        type: "update",
        payload: { id, content: updates[id] },
      });
    }
    inserts[id]?.forEach((insert, offset) => {
      if (!service.isRejected("insert", id + ":" + offset))
        row(`insert-${insert.id}-${offset}`, {
          type: "insert",
          payload: { from: id, offset, content: insert.content },
        });
    });
    return rows.length ? rows : null;
  }

  override disconnectedCallback() {
    this.decorated?.classList.remove("ai-block-diff-deleted");
    this.decorated = undefined;
    super.disconnectedCallback();
  }
}

export const blockDiffWidgetForBlock = WidgetViewExtension(
  "myoxus:note/*",
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK,
  MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK,
);
