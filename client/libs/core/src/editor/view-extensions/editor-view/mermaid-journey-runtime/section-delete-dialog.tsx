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
  type MermaidJourneyReactHostProps,
} from "@virgultum/block-mermaid";
import { useRef, useState } from "react";
export function JourneySectionDeleteDialog({
  props,
  id,
  onClose,
  onDeleted,
}: {
  props: MermaidJourneyReactHostProps;
  id: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(true);
  const completedRef = useRef<(() => void) | undefined>(undefined);
  const [basis] = useState(props.model.sourceDocument.source);
  const [target, setTarget] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const section = props.model.sections.find((section) => section.id === id);
  const count = props.model.steps.filter(
    (step) => step.sectionId === id,
  ).length;
  const removedIds = new Set([
    id,
    ...props.model.steps
      .filter((step) => step.sectionId === id)
      .map((step) => step.id),
  ]);
  const comments = props.model.comments.filter(
    (comment) => comment.anchorId && removedIds.has(comment.anchorId),
  ).length;
  const remove = (moveToSectionId?: string) => {
    const result = props.onCommand(
      { type: "delete", id, moveToSectionId },
      basis,
    );
    if (result.changed) {
      completedRef.current = onDeleted;
      setOpen(false);
    } else setNotice(true);
  };
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      // Focus follows the surviving source object after Mantine releases its trap.
      onExitTransitionEnd={() => {
        completedRef.current?.();
        onClose();
      }}
      title={`${messages.visualDelete()}: ${section?.title ?? messages.journeySection()}`}
    >
      <Stack>
        <MyoxusText>{messages.journeyDeleteImpact(count, comments)}</MyoxusText>
        {notice ? <Alert>{messages.ganttDiagnosticConflict()}</Alert> : null}
        {count > 0 &&
        props.model.sections.some(
          (section) => section.id !== id && section.writable,
        ) ? (
          <Select
            label={messages.journeySection()}
            value={target}
            onChange={setTarget}
            data={props.model.sections
              .filter((section) => section.id !== id && section.writable)
              .map((section) => ({
                label: section.title || messages.journeyUnnamed(),
                value: section.id,
              }))}
          />
        ) : null}
        <Group>
          <Button variant="plain" onClick={() => setOpen(false)}>
            {messages.cancel()}
          </Button>
          {!props.readonly ? (
            <>
              {count > 0 && target ? (
                <Button onClick={() => remove(target)}>
                  {messages.journeyMoveDelete()}
                </Button>
              ) : null}
              <Button variant="destructive" onClick={() => remove()}>
                {count ? messages.journeyDeleteAll() : messages.visualDelete()}
              </Button>
            </>
          ) : null}
        </Group>
      </Stack>
    </Modal>
  );
}
