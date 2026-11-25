import { WidgetViewExtension } from "@virgultum/editor/std";
import { createElement, type ReactNode } from "react";
import track from "@myoxus/track";
import { StoredAnswerText } from "../../components/ai-message-content/stored-answer-text";
import type { BlockDiffProvider } from "../../services/block-diff";
import { DiffWidget } from "./diff-widget";
import { DiffOptions } from "./view";

const styles = `
myoxus-block-diff-widget-for-block .ai-block-diff {
  position: relative;
  margin-top: var(--mantine-spacing-sm);
  margin-bottom: var(--mantine-spacing-sm);
  pointer-events: auto;
  background-color: var(--myoxus-background-processing-color);
  padding: var(--mantine-spacing-sm) 0;
  border-radius: var(--mantine-radius-sm);
}

myoxus-block-diff-widget-for-block .ai-block-diff.delete {
  position: absolute;
  top: calc(var(--mantine-spacing-sm) * -1);
  left: var(--mantine-spacing-xs);
  width: 100%;
  height: 100%;
  margin: 0;
  background: transparent;
}
myoxus-block-diff-widget-for-block .diff-options {
  position: absolute;
  top: 0;
  right: calc((var(--mantine-spacing-lg) + var(--mantine-spacing-xs)) * -1);
  pointer-events: auto;
  visibility: hidden;
}

myoxus-block-diff-widget-for-block .ai-block-diff:hover .diff-options {
  visibility: visible;
}
`;

export const MYOXUS_BLOCK_DIFF_WIDGET_FOR_BLOCK =
  "myoxus-block-diff-widget-for-block";
type Change = Parameters<BlockDiffProvider["accept"]>[0];

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
        createElement(
          "div",
          {
            key,
            className: "ai-block-diff " + change.type,
            "data-diff-id": key,
          },
          content !== null &&
            createElement(StoredAnswerText, {
              host: this.host,
              text: content,
            }),
          createElement(
            "div",
            { className: "diff-options" },
            createElement(DiffOptions, {
              accept: () => {
                track.applyModel.widget.block.accept();
                void service.accept(change, this.store);
              },
              reject: () => {
                track.applyModel.widget.block.reject();
                service.reject(change);
              },
            }),
          ),
        ),
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
    return rows.length
      ? [createElement("style", { key: "styles" }, styles), ...rows]
      : null;
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
