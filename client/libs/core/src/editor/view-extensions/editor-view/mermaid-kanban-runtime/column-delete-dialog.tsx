// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  Alert,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  MyoxusText,
} from "@myoxus/ui-facade";
import {
  mermaidMessages as messages,
  type MermaidKanbanReactHostProps,
} from "@virgultum/block-mermaid";
import { useState } from "react";
export function KanbanColumnDeleteDialog({
  props,
  id,
  onClose,
  onDeleted,
}: {
  props: MermaidKanbanReactHostProps;
  id: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [basis] = useState(props.model.sourceDocument.source);
  const [target, setTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const column = props.model.columns.find((column) => column.id === id);
  const count = props.model.cards.filter((card) => card.columnId === id).length;
  const removedIds = new Set([
    id,
    ...props.model.cards
      .filter((card) => card.columnId === id)
      .map((card) => card.id),
  ]);
  const comments = props.model.comments.filter(
    (comment) => comment.anchorId && removedIds.has(comment.anchorId),
  ).length;
  const remove = (moveToColumnId?: string) => {
    const result = props.onCommand(
      { type: "delete", id, moveToColumnId },
      basis,
    );
    if (result.changed) {
      onDeleted();
      onClose();
    } else setNotice(true);
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${messages.visualDelete()}: ${column?.label ?? messages.kanbanColumn()}`}
    >
      <Stack>
        <MyoxusText>{messages.kanbanDeleteImpact(count, comments)}</MyoxusText>
        {notice ? <Alert>{messages.ganttDiagnosticConflict()}</Alert> : null}
        {count &&
        props.model.columns.some(
          (column) => column.id !== id && column.writable,
        ) ? (
          <Select
            label={messages.kanbanColumn()}
            value={target}
            onChange={setTarget}
            data={props.model.columns
              .filter((column) => column.id !== id && column.writable)
              .map((column) => ({ label: column.label, value: column.id }))}
          />
        ) : null}
        <Group>
          <Button variant="plain" onClick={onClose}>
            {messages.cancel()}
          </Button>
          {!props.readonly ? (
            <>
              {count && target ? (
                <Button onClick={() => remove(target)}>
                  {messages.kanbanMoveDelete()}
                </Button>
              ) : null}
              <Button variant="destructive" onClick={() => remove()}>
                {count ? messages.kanbanDeleteAll() : messages.visualDelete()}
              </Button>
            </>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}
